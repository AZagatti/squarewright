import { expect, test } from "bun:test";
import { summarize, summarizeMatrix, sumUsage } from "./judge.js";

test("summarize: a single value has no spread (min = median = max)", () => {
  const s = summarize([7]);
  expect(s.min).toBe(7);
  expect(s.median).toBe(7);
  expect(s.max).toBe(7);
});

test("summarize: odd count picks the true middle regardless of input order", () => {
  const s = summarize([8, 2, 7]); // sorted: 2, 7, 8
  expect(s.min).toBe(2);
  expect(s.median).toBe(7);
  expect(s.max).toBe(8);
});

test("summarize: even count averages the two middle values", () => {
  // The exact stochastic-judge case from RESULTS.md: an identical report judged 8 then 7.
  const s = summarize([8, 7]);
  expect(s.min).toBe(7);
  expect(s.median).toBe(7.5);
  expect(s.max).toBe(8);
});

test("summarize: preserves the raw values so a report can print [8, 7, 8]", () => {
  expect(summarize([8, 7, 8]).values).toEqual([8, 7, 8]);
});

test("summarize: empty input yields zeros, never NaN", () => {
  const s = summarize([]);
  expect(s.min).toBe(0);
  expect(s.median).toBe(0);
  expect(s.max).toBe(0);
  expect(Number.isNaN(s.median)).toBe(false);
});

test("sumUsage: adds input/output across messages, skips ones without usage", () => {
  const u = sumUsage([
    { usage: { input: 100, output: 20 } },
    { role: "user" }, // no usage → skipped
    { usage: { input: 50, output: 10 } },
  ]);
  expect(u).toEqual({ input: 150, output: 30 });
});

test("sumUsage: falls back to totalTokens - input when output is absent", () => {
  // A message that reports only a total must still yield billable output — else a spend cap under-counts.
  const u = sumUsage([{ usage: { input: 80, totalTokens: 200 } }]);
  expect(u).toEqual({ input: 80, output: 120 });
});

test("sumUsage: never returns negative output when totalTokens < input", () => {
  const u = sumUsage([{ usage: { input: 200, totalTokens: 50 } }]);
  expect(u.output).toBe(0);
});

test("summarizeMatrix: decomposes overall, analysis, and judge variance", () => {
  // 3 analysis runs (rows) × 2 judge passes (cols) of the same config.
  const m = summarizeMatrix([
    [6, 6],
    [4, 5],
    [7, 8],
  ]);
  // overall = spread of all 6 values: sorted [4,5,6,6,7,8]
  expect(m.overall.min).toBe(4);
  expect(m.overall.median).toBe(6);
  expect(m.overall.max).toBe(8);
  // analysis = spread of per-report medians [6, 4.5, 7.5]
  expect(m.analysis.min).toBe(4.5);
  expect(m.analysis.median).toBe(6);
  expect(m.analysis.max).toBe(7.5);
  // judge = spread of per-report (max-min) ranges [0, 1, 1]
  expect(m.judge.min).toBe(0);
  expect(m.judge.median).toBe(1);
  expect(m.judge.max).toBe(1);
});

test("summarizeMatrix: a single report × single pass collapses to a point", () => {
  const m = summarizeMatrix([[3]]);
  expect(m.overall).toMatchObject({ max: 3, median: 3, min: 3 });
  expect(m.analysis).toMatchObject({ max: 3, median: 3, min: 3 });
  expect(m.judge).toMatchObject({ max: 0, median: 0, min: 0 });
});

test("summarizeMatrix: empty matrix yields zeros, never NaN", () => {
  const m = summarizeMatrix([]);
  expect(m.overall.median).toBe(0);
  expect(Number.isNaN(m.overall.median)).toBe(false);
});
