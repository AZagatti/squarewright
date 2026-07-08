import { describe, expect, test } from "bun:test";
import type { Persona } from "../core/types.js";
import { buildPasses, DEFAULT_PERSONAS, passGroup } from "./defaults.js";
import { selectPersonas } from "./routing.js";

function persona(over: Partial<Persona> & { id: string }): Persona {
  return { lane: "cheap", prompt: `checklist for ${over.id}`, ...over };
}

describe("passGroup", () => {
  test("explicit pass wins over solo and over the baseline default", () => {
    expect(passGroup(persona({ id: "a", pass: "infra", solo: true }))).toBe(
      "infra"
    );
    expect(passGroup(persona({ id: "b", solo: true }))).toBe("b");
    expect(passGroup(persona({ id: "c" }))).toBe("baseline");
  });
});

describe("buildPasses", () => {
  test("non-solo personas share one batched 'baseline' pass (legacy behavior)", () => {
    const passes = buildPasses([persona({ id: "a" }), persona({ id: "b" })]);
    expect(passes).toHaveLength(1);
    expect(passes[0]?.id).toBe("baseline");
    expect(passes[0]?.personaIds).toEqual(["a", "b"]);
    // a >1 group carries the multi-lens preamble naming every lens
    expect(passes[0]?.prompt).toContain("Apply ALL of the following");
    expect(passes[0]?.prompt).toContain("### Lens: a");
    expect(passes[0]?.prompt).toContain("### Lens: b");
  });

  test("solo personas each get their own bare-prompt pass (legacy behavior)", () => {
    const passes = buildPasses([
      persona({ id: "s1", solo: true }),
      persona({ id: "s2", solo: true }),
    ]);
    expect(passes.map((p) => p.id).sort((a, b) => a.localeCompare(b))).toEqual([
      "s1",
      "s2",
    ]);
    // a lone member runs its own prompt, no multi-lens preamble
    expect(passes[0]?.prompt).toBe("checklist for s1");
    expect(passes[0]?.prompt).not.toContain("Apply ALL");
  });

  test("co-firing personas sharing a `pass` batch into ONE call", () => {
    const passes = buildPasses([
      persona({ id: "dock", pass: "infra" }),
      persona({ id: "ci", pass: "infra" }),
    ]);
    expect(passes).toHaveLength(1);
    expect(passes[0]?.id).toBe("infra");
    expect(passes[0]?.personaIds).toEqual(["dock", "ci"]);
    expect(passes[0]?.prompt).toContain("### Lens: dock");
    expect(passes[0]?.prompt).toContain("### Lens: ci");
  });

  test("a pass-group with a single present member runs unpaired (bare prompt)", () => {
    const passes = buildPasses([persona({ id: "dock", pass: "infra" })]);
    expect(passes).toHaveLength(1);
    expect(passes[0]?.id).toBe("infra");
    expect(passes[0]?.prompt).toBe("checklist for dock");
    expect(passes[0]?.prompt).not.toContain("Apply ALL");
  });

  test("batched group's thinking is the max over its members", () => {
    const passes = buildPasses([
      persona({ id: "x", pass: "g", thinking: "off" }),
      persona({ id: "y", pass: "g", thinking: "high" }),
    ]);
    expect(passes[0]?.thinking).toBe("high");
  });
});

describe("default personas: NO default pairing (deliberate)", () => {
  const file = (path: string) => ({
    patch: "@@ -1,1 +1,2 @@\n a\n+b\n",
    path,
    status: "modified" as const,
  });

  // #39 shipped the `pass` primitive but NOT a default pairing: batching correlated lenses was measured only
  // for general batching intensity (single model) and cannot be corpus-validated (no golden case co-touches
  // Docker+CI). So stevedore and marshal run SEPARATELY by default — the pairing stays opt-in via config.
  test("a PR touching BOTH a Dockerfile and a CI workflow runs stevedore and marshal as SEPARATE passes", () => {
    const selected = selectPersonas(
      DEFAULT_PERSONAS,
      [file("Dockerfile"), file(".github/workflows/ci.yml")],
      { cap: 6 }
    );
    const passes = buildPasses(selected);
    expect(passes.find((p) => p.id === "stevedore")?.personaIds).toEqual([
      "stevedore",
    ]);
    expect(passes.find((p) => p.id === "marshal")?.personaIds).toEqual([
      "marshal",
    ]);
    // no batched "infra" (or any multi-persona domain) pass exists by default
    expect(
      passes.some((p) => p.personaIds.length > 1 && p.id !== "baseline")
    ).toBe(false);
  });
});
