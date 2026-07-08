import { expect, test } from "bun:test";
import { formatRange, summarize } from "./variance.js";

test("summarize: odd count picks the middle value", () => {
  expect(summarize([3, 1, 2])).toEqual({ max: 3, median: 2, min: 1 });
});

test("summarize: even count averages the two middle values", () => {
  expect(summarize([1, 2, 3, 4])).toEqual({ max: 4, median: 2.5, min: 1 });
});

test("summarize: single value and empty", () => {
  expect(summarize([5])).toEqual({ max: 5, median: 5, min: 5 });
  expect(summarize([])).toEqual({ max: 0, median: 0, min: 0 });
});

test("formatRange: a range, never a bare point when there is spread", () => {
  expect(formatRange(summarize([1, 3, 1]))).toBe("1–3 (median 1)");
});

test("formatRange: collapses to a single number with no spread", () => {
  expect(formatRange(summarize([2, 2, 2]))).toBe("2");
});
