import { expect, test } from "bun:test";
import { sameFile } from "./locus-match.js";
import {
  type GoldenLoci,
  type MissReport,
  perLocusHitRates,
  reportsCoveringGolden,
} from "./missmap.js";

// ── sameFile (shared file-match rule) ────────────────────────────────────────

test("sameFile: exact, suffix, and basename matches all count; unrelated paths don't", () => {
  expect(sameFile("src/a.ts", "src/a.ts")).toBe(true);
  expect(sameFile("packages/x/src/a.ts", "src/a.ts")).toBe(true); // finding deeper than locus
  expect(sameFile("a.ts", "pkg/a.ts")).toBe(true); // locus deeper than finding
  expect(sameFile("dir/a.ts", "other/a.ts")).toBe(true); // same basename
  expect(sameFile("src/a.ts", "src/b.ts")).toBe(false);
});

// ── perLocusHitRates ─────────────────────────────────────────────────────────

const golden: GoldenLoci = new Map([
  ["case-a", ["src/a.ts", "src/b.ts"]],
  ["case-c", ["src/c.ts"]],
]);

function report(
  config: Record<string, unknown>,
  results: MissReport["results"]
): MissReport {
  return { config, results };
}

test("perLocusHitRates: counts a locus hit when any finding is sameFile, per report", () => {
  const reports: MissReport[] = [
    report({}, [{ findings: [{ path: "src/a.ts" }], id: "case-a" }]), // hits a#0, misses a#1
    report({}, [
      { findings: [{ path: "x/a.ts" }, { path: "src/b.ts" }], id: "case-a" },
    ]), // hits a#0 (basename) and a#1
  ];
  const rows = perLocusHitRates(reports, golden);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  expect(byKey.get("case-a#0")).toMatchObject({ hit: 2, rate: 1, total: 2 });
  expect(byKey.get("case-a#1")).toMatchObject({ hit: 1, rate: 0.5, total: 2 });
  // case-c never appeared → total 0, rate 0 (never a fabricated hit)
  expect(byKey.get("case-c#0")).toMatchObject({ hit: 0, rate: 0, total: 0 });
});

test("perLocusHitRates: rows are sorted hardest-first (lowest rate)", () => {
  const reports: MissReport[] = [
    report({}, [
      { findings: [{ path: "src/b.ts" }], id: "case-a" }, // hits a#1 only
      { findings: [{ path: "src/c.ts" }], id: "case-c" }, // hits c#0
    ]),
  ];
  const rows = perLocusHitRates(reports, golden);
  // a#0 (0/1) is hardest, before a#1 and c#0 (both 1/1)
  expect(rows[0]?.key).toBe("case-a#0");
  expect(rows[0]?.rate).toBe(0);
});

test("perLocusHitRates: a segment predicate restricts the tally to matching configs", () => {
  const reports: MissReport[] = [
    report({ model: "strong-x" }, [
      { findings: [{ path: "src/a.ts" }], id: "case-a" }, // strong hits a#0
    ]),
    report({ model: "weak-y" }, [
      { findings: [], id: "case-a" }, // weak misses a#0
    ]),
  ];
  const strong = perLocusHitRates(reports, golden, (c) =>
    String(c?.model).startsWith("strong")
  );
  const a0 = strong.find((r) => r.key === "case-a#0");
  expect(a0).toMatchObject({ hit: 1, total: 1 }); // only the strong report counted
});

test("reportsCoveringGolden: counts reports that ran at least one golden case", () => {
  const reports: MissReport[] = [
    report({}, [{ findings: [], id: "case-a" }]),
    report({}, [{ findings: [], id: "not-golden" }]), // covers nothing
    report({}, [{ findings: [], id: "case-c" }]),
  ];
  expect(reportsCoveringGolden(reports, golden)).toBe(2);
});
