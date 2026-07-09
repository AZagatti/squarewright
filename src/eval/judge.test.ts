import { expect, test } from "bun:test";
import { summarize } from "./judge.js";

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
