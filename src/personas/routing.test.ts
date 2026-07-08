import { describe, expect, test } from "bun:test";
import type { ChangedFile, Persona } from "../core/types.js";
import { selectPersonas } from "./routing.js";

const FILES: ChangedFile[] = [
  { patch: "@@ -1,1 +1,2 @@\n a\n+b\n", path: "src/a.ts", status: "modified" },
];

// All always-on so `when`/globs don't gate the test — we're isolating the cap's group behavior.
function p(id: string, pass?: string): Persona {
  return {
    id,
    lane: "cheap",
    prompt: id,
    when: ["always"],
    ...(pass ? { pass } : {}),
  };
}

describe("selectPersonas cap is group-aware", () => {
  test("with no `pass`, the cap is a plain priority prefix (unchanged behavior)", () => {
    const selected = selectPersonas(
      [p("a"), p("b"), p("c"), p("d"), p("e")],
      FILES,
      { cap: 3 }
    );
    expect(selected.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  test("a declared group that fits within the cap is kept whole", () => {
    const selected = selectPersonas(
      [p("a"), p("b"), p("g1", "g"), p("g2", "g")],
      FILES,
      { cap: 4 }
    );
    expect(
      selected.map((x) => x.id).sort((m, n) => m.localeCompare(n))
    ).toEqual(["a", "b", "g1", "g2"]);
  });

  // The acceptance criterion: never keep one member of a declared group while dropping its partner.
  test("mid-group truncation drops the WHOLE group rather than splitting it", () => {
    const selected = selectPersonas(
      [p("a"), p("b"), p("c"), p("g1", "g"), p("g2", "g")],
      FILES,
      { cap: 4 }
    );
    const ids = selected.map((x) => x.id);
    // group "g" straddles the cap boundary (3 singles already fill 3 of 4 slots) → dropped whole, not split
    expect(ids).not.toContain("g1");
    expect(ids).not.toContain("g2");
    expect(ids).toEqual(["a", "b", "c"]);
    // and it never ships a half-formed pair (exactly one of g1/g2)
    expect(ids.includes("g1")).toBe(ids.includes("g2"));
  });

  test("a smaller unit after an over-cap group can still fill the remaining slot", () => {
    // order: a, b, g1, g2, c  → after a,b (2), group g (2) fits → 4; c would be 5, skipped
    const selected = selectPersonas(
      [p("a"), p("b"), p("g1", "g"), p("g2", "g"), p("c")],
      FILES,
      { cap: 4 }
    );
    expect(selected.map((x) => x.id)).toEqual(["a", "b", "g1", "g2"]);
  });
});
