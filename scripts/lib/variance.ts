/**
 * Multi-run variance for the eval. The harness swings run-to-run on identical config (recorded in
 * eval/RESULTS.md), so a single number is unfalsifiable — the North Star's "refuses a single flattering blended
 * number" applies to our own measurement. `summarize` + `formatRange` turn N per-run values into a median±range.
 */

export interface Summary {
  max: number;
  median: number;
  min: number;
}

/** Median, min, and max of the values (empty → all zero). */
export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { max: 0, median: 0, min: 0 };
  }
  const mid = Math.floor(n / 2);
  const median =
    n % 2 === 1
      ? sorted[mid]
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { max: sorted[n - 1] ?? 0, median: median ?? 0, min: sorted[0] ?? 0 };
}

/** "2" when there is no spread, else "1–3 (median 2)" — a range, never a bare point. */
export function formatRange(s: Summary): string {
  if (s.min === s.max) {
    return `${s.min}`;
  }
  return `${s.min}–${s.max} (median ${s.median})`;
}
