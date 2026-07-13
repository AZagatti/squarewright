/**
 * Parse the GitHub "closing keywords" in a PR body that link it to the issue(s) it resolves
 * (`Closes #12`, `Fixes: #7`, `resolved #3`). The first, pure, no-network slice of AC-conformance
 * — which the eval settled as VIABLE with a stronger-model check pass (eval/RESULTS.md, 2026-07-13):
 * a reviewer that fetches a referenced issue's acceptance criteria and flags SILENTLY-unmet ones.
 *
 * This function only turns "which issue(s) does this PR close" into a deterministic fact — no network,
 * no LLM, no trust surface. Issue *fetching* (untrusted text → user-turn only) and the strong-lane
 * check pass are later slices, deliberately kept separate from this pure parse.
 */

// GitHub's closing keywords (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved),
// case-insensitive, followed by an optional colon and a `#<number>` reference. `\b` before the keyword
// stops "discloses"/"prefix" from matching inside a larger word.
const CLOSING_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

/**
 * Extract the issue numbers a PR body declares it closes, de-duplicated and in first-seen order.
 * Same-repo `#N` references only (cross-repo `owner/repo#N` and URL forms are intentionally out of scope
 * for v1 — AC-conformance checks a PR against its OWN repo's issue). Returns `[]` for empty/None bodies.
 */
export function parseIssueRefs(prBody: string | null | undefined): number[] {
  if (!prBody) {
    return [];
  }
  const seen = new Set<number>();
  for (const m of prBody.matchAll(CLOSING_RE)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) {
      seen.add(n);
    }
  }
  return [...seen];
}
