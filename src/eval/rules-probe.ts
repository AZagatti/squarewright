/**
 * Rules probe — the honest, repeatable measurement of whether a Tier-A `.review-rules` rule actually changes a
 * review (ADR-0005 §1; Hard Rule #5). `detectRuleFinding` is the pure decision at the heart of it: given a
 * review's output and a target (the file/line + the rule's concept keywords), did the reviewer flag the injected
 * rule-violation? Kept deterministic (no LLM) so the *measurement of the measurement* has no stochasticity of its
 * own — the reviewer run is the only variable, and `scripts/measure-rules.ts` repeats it N times per arm.
 *
 * "Flagged" = a finding on the target file, within `LINE_TOLERANCE` lines of the target, whose text mentions any
 * of the rule's concept keywords. This is intentionally strict on location (a finding on the right file but a
 * different line/topic does NOT count — same spirit as the defect-match judge) and cheap to reproduce.
 */

/** A finding as it appears in the review CLI's JSON: inline comments carry `body`, unplaceable carry `message`. */
export interface ProbeFinding {
  line: number;
  path: string;
  text: string;
}

/** The rule-violation we expect a rule to surface: where it is, and the words a real finding would use. */
export interface RuleTarget {
  keywords: string[];
  line: number;
  path: string;
}

/** A finding within this many lines of the target counts as "on" it (diff line numbering is approximate). */
export const LINE_TOLERANCE = 3;

/** Normalize the review CLI's `{ inline, unplaceable }` output into flat findings for probing. */
export function toProbeFindings(output: {
  inline?: { body: string; line: number; path: string }[];
  unplaceable?: { line: number; message: string; path: string }[];
}): ProbeFinding[] {
  const inline = (output.inline ?? []).map((f) => ({
    line: f.line,
    path: f.path,
    text: f.body,
  }));
  const unplaceable = (output.unplaceable ?? []).map((f) => ({
    line: f.line,
    path: f.path,
    text: f.message,
  }));
  return [...inline, ...unplaceable];
}

/** Did the review flag the targeted rule-violation? Strict on location + concept, deterministic. */
export function detectRuleFinding(
  findings: ProbeFinding[],
  target: RuleTarget
): boolean {
  const keywords = target.keywords.map((k) => k.toLowerCase());
  return findings.some((f) => {
    if (f.path !== target.path) {
      return false;
    }
    if (Math.abs(f.line - target.line) > LINE_TOLERANCE) {
      return false;
    }
    const text = f.text.toLowerCase();
    return keywords.some((k) => text.includes(k));
  });
}
