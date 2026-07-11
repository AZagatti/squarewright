/**
 * Golden-corpus miss map (issue #45 AC1). Aggregates the file-level recall of each expected defect locus across
 * a set of saved eval reports, so "which loci are missed, and how consistently" is a reproducible measurement
 * rather than a hand-written table. Pure: it takes already-parsed reports + the golden loci and returns stats,
 * so it's testable without touching disk or a model. The CLI wrapper (`scripts/missmap.ts`) reads the manifest
 * and `eval/reports/`.
 *
 * File-level only (via `sameFile`): a hit means a finding on the locus's file, not that it named the root cause.
 * So these rates are an UPPER bound on true (defect-level) recall — the judge measures the rest.
 */
import { sameFile } from "./locus-match.js";

export interface MissReport {
  config?: Record<string, unknown>;
  results?: Array<{
    id: string;
    findings?: Array<{ path: string }>;
  }>;
}

/** A locus key is `<caseId>#<lociIndex>`, e.g. `ts-vite-21019#0`. */
export interface LocusStat {
  /** reports (covering this case) in which some finding hit the locus's file */
  hit: number;
  key: string;
  path: string;
  /** hit / total, or 0 when total is 0 */
  rate: number;
  /** reports that ran this locus's case at all */
  total: number;
}

/** golden has-issue cases → their expected locus file paths, in manifest order. */
export type GoldenLoci = Map<string, string[]>;

/**
 * Per-locus file-hit rate across `reports`. A report contributes to a locus's `total` iff it ran that locus's
 * case; `hit` increments when any of that result's findings is `sameFile` as the locus. An optional `segment`
 * predicate restricts the tally to reports whose config matches (e.g. grounded-only, strong-model-only) so a
 * miss can be attributed to a config axis. Rows are returned hardest-first (lowest rate).
 */
export function perLocusHitRates(
  reports: MissReport[],
  golden: GoldenLoci,
  segment?: (config: Record<string, unknown> | undefined) => boolean
): LocusStat[] {
  const stat = new Map<string, { hit: number; total: number; path: string }>();
  for (const [id, loci] of golden) {
    for (const [i, path] of loci.entries()) {
      stat.set(`${id}#${i}`, { hit: 0, path, total: 0 });
    }
  }

  for (const report of reports) {
    if (segment && !segment(report.config)) {
      continue;
    }
    for (const result of report.results ?? []) {
      const loci = golden.get(result.id);
      if (!loci) {
        continue;
      }
      const findings = result.findings ?? [];
      loci.forEach((locusPath, i) => {
        const s = stat.get(`${result.id}#${i}`);
        if (!s) {
          return;
        }
        s.total += 1;
        if (findings.some((f) => sameFile(f.path, locusPath))) {
          s.hit += 1;
        }
      });
    }
  }

  return [...stat.entries()]
    .map(([key, s]) => ({
      hit: s.hit,
      key,
      path: s.path,
      rate: s.total === 0 ? 0 : s.hit / s.total,
      total: s.total,
    }))
    .sort((a, b) => a.rate - b.rate);
}

/** How many of `reports` ran at least one of the golden cases — the denominator context for the table. */
export function reportsCoveringGolden(
  reports: MissReport[],
  golden: GoldenLoci
): number {
  let n = 0;
  for (const report of reports) {
    if ((report.results ?? []).some((r) => golden.has(r.id))) {
      n += 1;
    }
  }
  return n;
}
