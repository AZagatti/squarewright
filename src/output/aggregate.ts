/**
 * Aggregate findings from multiple personas into one deduplicated set. Two personas flagging the same issue
 * (same file, near line, overlapping wording) collapse into one with a bumped consensus — deterministic, no
 * extra model call (an LLM merge is a lossy recall leak).
 */
import type { Finding, Severity } from "../core/types.js";

const SEV_RANK: Record<Severity, number> = { error: 3, info: 1, warning: 2 };

export interface AggregatedFinding extends Finding {
  /** how many personas independently raised this */
  consensus: number;
  /** persona ids that raised it */
  sources: string[];
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 2)
  );
}

/** Jaccard overlap of two token sets. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) {
      inter += 1;
    }
  }
  return inter / (a.size + b.size - inter);
}

/**
 * Same issue if same file, within 3 lines, and messages meaningfully overlap. When `crossSourceOnly`, a finding is
 * NEVER folded into one that already carries its source: within a single persona pass the model has already
 * de-duplicated its own output, so two same-source findings at nearby lines are the model's DISTINCT findings —
 * merging them silently drops one (a recall leak). Production passes `crossSourceOnly` so only genuine
 * cross-persona agreement collapses; the eval's `--samples` path leaves it off so re-sampled duplicates of one
 * persona still union (that's the whole point of self-consistency).
 */
function isSame(
  a: AggregatedFinding,
  b: Finding,
  crossSourceOnly: boolean
): boolean {
  if (a.path !== b.path) {
    return false;
  }
  if (crossSourceOnly && a.sources.includes(b.source ?? b.rule)) {
    return false;
  }
  // Line-less findings (PR-level, e.g. AC-conformance) have no meaningful proximity; `Math.abs(NaN) > 3` is
  // `false`, which would silently let them merge on text alone. A missing line is never a proximity match.
  if (!(Number.isFinite(a.line) && Number.isFinite(b.line))) {
    return false;
  }
  if (Math.abs(a.line - b.line) > 3) {
    return false;
  }
  return overlap(tokens(a.message), tokens(b.message)) >= 0.4;
}

/** Fold a duplicate `f` into the surviving `existing`: bump consensus, keep the strongest/richest fields. */
function mergeInto(existing: AggregatedFinding, f: Finding): void {
  existing.consensus += 1;
  const src = f.source ?? f.rule;
  if (!existing.sources.includes(src)) {
    existing.sources.push(src);
  }
  // keep the highest severity and the longer (richer) message
  if (SEV_RANK[f.severity] > SEV_RANK[existing.severity]) {
    existing.severity = f.severity;
  }
  if (f.message.length > existing.message.length) {
    existing.message = f.message;
  }
  if (!existing.suggestion && f.suggestion) {
    existing.suggestion = f.suggestion;
  }
  // A rule-drift proposal (ADR-0005 §2) attaches to "the issue it came from" — which another persona may
  // independently flag nearby and land first as `existing`. Carry the proposal over so the cap's single
  // survivor still reaches render instead of being silently dropped in the same-issue collapse.
  if (!existing.proposedRule && f.proposedRule) {
    existing.proposedRule = f.proposedRule;
  }
}

export function aggregateFindings(
  findings: Finding[],
  opts: { crossSourceOnly?: boolean } = {}
): AggregatedFinding[] {
  const crossSourceOnly = opts.crossSourceOnly ?? false;
  const out: AggregatedFinding[] = [];
  for (const f of findings) {
    const existing = out.find((e) => isSame(e, f, crossSourceOnly));
    if (existing) {
      mergeInto(existing, f);
    } else {
      out.push({ ...f, consensus: 1, sources: [f.source ?? f.rule] });
    }
  }
  // strongest first: severity, then consensus
  out.sort(
    (a, b) =>
      SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.consensus - a.consensus
  );
  return out;
}
