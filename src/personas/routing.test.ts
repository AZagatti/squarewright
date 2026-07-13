import { describe, expect, test } from "bun:test";
import type { ChangedFile, Persona } from "../core/types.js";
import {
  matchGlob,
  selectPersonas,
  selectPersonasWithDrops,
} from "./routing.js";

describe("matchGlob: **/X matches whole segments only, not partial filenames", () => {
  test("**/X matches X at any depth (including root), NOT names merely ending in X", () => {
    expect(matchGlob("**/package.json", "package.json")).toBe(true);
    expect(matchGlob("**/package.json", "src/package.json")).toBe(true);
    // the bug: these used to match because **/ collapsed to `.*`
    expect(matchGlob("**/package.json", "notapackage.json")).toBe(false);
    expect(matchGlob("**/package.json", "vendor-package.json")).toBe(false);
    expect(matchGlob("**/foo", "barfoo")).toBe(false);
    expect(matchGlob("**/Dockerfile", "notDockerfile")).toBe(false);
  });

  test("a/**/b requires b to be a whole segment", () => {
    expect(matchGlob("a/**/b", "a/b")).toBe(true);
    expect(matchGlob("a/**/b", "a/x/b")).toBe(true);
    expect(matchGlob("a/**/b", "a/config.rb")).toBe(false);
  });

  test("**/*.ts still matches root and nested files", () => {
    expect(matchGlob("**/*.ts", "a.ts")).toBe(true);
    expect(matchGlob("**/*.ts", "src/deep/a.ts")).toBe(true);
    expect(matchGlob("**/*.ts", "a.tsx")).toBe(false);
  });

  test("single * stays within a segment; ? is one non-slash char", () => {
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(matchGlob("a?.ts", "ab.ts")).toBe(true);
    expect(matchGlob("a?.ts", "a/.ts")).toBe(false);
  });
});

test('the `always` sentinel is case-insensitive — a `when: ["Always"]` typo isn\'t a dead lens', () => {
  const typo: Persona = {
    id: "gen",
    lane: "cheap",
    prompt: "x",
    when: ["Always"], // case typo: would be a literal glob matching nothing without the fix
  };
  // a change-set no glob would match — the case-typo'd always-on persona must still run
  const selected = selectPersonas(
    [typo],
    [{ patch: "@@ @@", path: "docs/readme.md", status: "modified" }],
    { cap: 4 }
  );
  expect(selected.map((s) => s.id)).toEqual(["gen"]);
});

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

  test("a group that fits is kept whole; a later unit that would overflow is skipped", () => {
    // order: a, b, g1, g2, c  → after a,b (2), group g (2) fits → 4; c would be 5, skipped
    const selected = selectPersonas(
      [p("a"), p("b"), p("g1", "g"), p("g2", "g"), p("c")],
      FILES,
      { cap: 4 }
    );
    expect(selected.map((x) => x.id)).toEqual(["a", "b", "g1", "g2"]);
  });

  test("a group skipped for overflow does NOT block a later single unit from filling the slot", () => {
    // order: a, b, c, g1, g2, d — a,b,c fill 3; group g (2) overflows cap 4 → skipped; single d fits → 4
    const selected = selectPersonas(
      [p("a"), p("b"), p("c"), p("g1", "g"), p("g2", "g"), p("d")],
      FILES,
      { cap: 4 }
    );
    const ids = selected.map((x) => x.id);
    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(ids).not.toContain("g1");
    expect(ids).not.toContain("g2");
  });
});

test("an acCheck (AC-conformance) persona is excluded from glob routing — it's context-gated, not file-gated", () => {
  const picked = selectPersonas(
    [
      { id: "gen", lane: "cheap", prompt: "g", when: ["always"] },
      {
        acCheck: true,
        id: "auditor",
        lane: "strong",
        prompt: "a",
        when: ["always"],
      },
    ],
    FILES
  );
  expect(picked.map((x) => x.id)).toEqual(["gen"]);
});

describe("selectPersonasWithDrops reports what the cap cut", () => {
  test("reports matched-but-dropped personas in original order (for honest disclosure)", () => {
    const { selected, dropped } = selectPersonasWithDrops(
      [p("a"), p("b"), p("c"), p("d"), p("e"), p("f")],
      FILES,
      { cap: 4 }
    );
    expect(selected.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    // dropped preserves the personas' own order, not the priority-sorted order
    expect(dropped.map((x) => x.id)).toEqual(["e", "f"]);
  });

  test("no cap pressure → nothing dropped", () => {
    const { selected, dropped } = selectPersonasWithDrops(
      [p("a"), p("b")],
      FILES,
      { cap: 4 }
    );
    expect(selected.map((x) => x.id)).toEqual(["a", "b"]);
    expect(dropped).toEqual([]);
  });

  test("a whole group dropped by the cap is reported as dropped, not split", () => {
    const { selected, dropped } = selectPersonasWithDrops(
      [p("a"), p("b"), p("c"), p("g1", "g"), p("g2", "g")],
      FILES,
      { cap: 4 }
    );
    expect(selected.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(dropped.map((x) => x.id)).toEqual(["g1", "g2"]);
  });
});
