import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAssemblyConfig } from "./config.js";

const MINIMAL = `
lanes:
  - id: cheap
    provider: zai
    model: glm-5-turbo
personas:
  - id: gen
    lane: cheap
    prompt: review it
`;

function configDir(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sqw-config-"));
  writeFileSync(join(dir, ".squarewright.yml"), text);
  return dir;
}

describe("loadAssemblyConfig", () => {
  test("loads and validates a .squarewright.yml", () => {
    const config = loadAssemblyConfig(configDir(MINIMAL));
    expect(config.lanes[0]?.id).toBe("cheap");
    expect(config.personas[0]?.lane).toBe("cheap");
    // an optional `label` is absent when unset (attribution falls back to the id)
    expect(config.personas[0]?.label).toBeUndefined();
  });

  test("parses an explicit persona `pass` group-key from YAML", () => {
    const withPass = `
lanes:
  - id: cheap
    provider: zai
    model: glm-5-turbo
personas:
  - id: dock
    lane: cheap
    prompt: docker
    pass: infra
  - id: ci
    lane: cheap
    prompt: ci
    pass: infra
`;
    const config = loadAssemblyConfig(configDir(withPass));
    expect(config.personas.map((p) => p.pass)).toEqual(["infra", "infra"]);
  });

  test("accepts an optional structurer lane", () => {
    const config = loadAssemblyConfig(
      configDir(
        `${MINIMAL}structurer:\n  id: struct\n  provider: zai\n  model: glm-5-turbo\n`
      )
    );
    expect(config.structurer?.provider).toBe("zai");
  });

  test("structurer is optional", () => {
    const config = loadAssemblyConfig(configDir(MINIMAL));
    expect(config.structurer).toBeUndefined();
  });

  test("throws a helpful error when the config is missing", () => {
    expect(() => loadAssemblyConfig(join(tmpdir(), "no-config-sqw"))).toThrow(
      "No .squarewright.yml"
    );
  });

  test("rejects duplicate persona ids (would silently drop a lens / mis-route its lane)", () => {
    const dup = `
lanes:
  - { id: cheap, provider: zai, model: glm-5-turbo }
personas:
  - { id: gen, lane: cheap, prompt: a }
  - { id: gen, lane: cheap, prompt: b }
`;
    expect(() => loadAssemblyConfig(configDir(dup))).toThrow(
      "duplicate persona id"
    );
  });

  test("rejects duplicate lane ids", () => {
    const dup = `
lanes:
  - { id: cheap, provider: zai, model: glm-5-turbo }
  - { id: cheap, provider: openrouter, model: x }
personas:
  - { id: gen, lane: cheap, prompt: a }
`;
    expect(() => loadAssemblyConfig(configDir(dup))).toThrow(
      "duplicate lane id"
    );
  });

  test("rejects a persona whose lane references an undefined lane (typo/rename) — caught at load, not mid-review", () => {
    // "chea" ≠ "cheap": otherwise passes config load AND `doctor`, then throws mid-review at laneForPass.
    const dangling = `
lanes:
  - { id: cheap, provider: zai, model: glm-5-turbo }
personas:
  - { id: gen, lane: chea, prompt: a }
`;
    // ZodError JSON-escapes quotes in its message, so match the quote-free phrase.
    expect(() => loadAssemblyConfig(configDir(dangling))).toThrow(
      "references lane"
    );
  });

  test("rejects a defaultLane that references an undefined lane", () => {
    const dangling = `
defaultLane: nope
lanes:
  - { id: cheap, provider: zai, model: glm-5-turbo }
personas:
  - { id: gen, lane: cheap, prompt: a }
`;
    expect(() => loadAssemblyConfig(configDir(dangling))).toThrow(
      "is not a defined lane"
    );
  });

  test("accepts a config whose persona lanes + defaultLane all resolve", () => {
    const ok = `
defaultLane: cheap
lanes:
  - { id: cheap, provider: zai, model: glm-5-turbo }
  - { id: strong, provider: openrouter, model: big }
personas:
  - { id: gen, lane: cheap, prompt: a }
  - { id: sec, lane: strong, prompt: b }
`;
    expect(loadAssemblyConfig(configDir(ok)).personas).toHaveLength(2);
  });

  test("rejects an unknown/typo'd key instead of silently ignoring it (strict)", () => {
    // `cotScafold` (typo) must NOT silently leave the scaffold off — strict mode rejects the config
    const typo = `${MINIMAL}cotScafold: true\n`;
    expect(() => loadAssemblyConfig(configDir(typo))).toThrow();
    // a typo'd persona key is caught too
    const personaTypo = `
lanes:
  - { id: cheap, provider: zai, model: glm-5-turbo }
personas:
  - { id: gen, lane: cheap, prompt: a, laen: cheap }
`;
    expect(() => loadAssemblyConfig(configDir(personaTypo))).toThrow();
  });
});

describe("schema error formatting (#195)", () => {
  test("a schema violation throws a readable path: message, not a raw ZodError JSON dump", () => {
    // a typo'd top-level key trips strict mode — the message must read like prose, not JSON issue objects
    const typo = `${MINIMAL}cotScafold: true\n`;
    let message = "";
    try {
      loadAssemblyConfig(configDir(typo));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toStartWith("Invalid .squarewright.yml:");
    expect(message).toContain("Unrecognized key");
    // none of the raw Zod JSON shape leaks through
    expect(message).not.toContain('"code"');
    expect(message).not.toContain("[{");
  });

  test("an empty lanes array reports the min-length rule in words, keyed by path", () => {
    const emptyLanes = `
lanes: []
personas:
  - id: gen
    lane: cheap
    prompt: review it
`;
    let message = "";
    try {
      loadAssemblyConfig(configDir(emptyLanes));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("lanes");
    expect(message.toLowerCase()).toContain("at least 1");
  });
});
