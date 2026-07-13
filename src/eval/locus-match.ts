/**
 * File-level locus match: does a reviewer finding land on the same file as an expected defect locus? This is the
 * boundary-safe, path-suffix/basename rule the eval uses for `hitLoci` recall, shared so the miss-map
 * (`missmap.ts`) scores loci by the SAME definition the eval reports do — one source, no drift. It is file-level
 * only: it cannot see whether the finding names the real root cause (that's the judge's defect-level metric).
 */
export function sameFile(findingPath: string, locusPath: string): boolean {
  return (
    findingPath === locusPath ||
    findingPath.endsWith(`/${locusPath}`) ||
    locusPath.endsWith(`/${findingPath}`) ||
    findingPath.split("/").pop() === locusPath.split("/").pop()
  );
}

/**
 * A path-like token in free prose: an optional dir prefix then `name.ext` (ext ≤ 8 word-chars). Requires a word
 * char immediately before the final dot, so bare dotfiles (`.env`, `.gitignore`) don't match — a narrow, accepted
 * false-negative gap, since defect loci in the corpus are essentially always normal source files with real names.
 */
const PATH_TOKEN_RE = /[\w./-]*\w+\.\w{1,8}/g;

/**
 * Fixed-analysis loci-recall: did the raw pass-1 analysis PROSE name a file `sameFile`-equal to `locusPath`,
 * regardless of whether the structurer (pass 2) later emitted a finding on it? This isolates the analysis model's
 * reachability from the structurer's extraction, retiring the #78 confound where a weak structurer silently drops
 * a locus a capable analysis actually surfaced. It reuses the SAME `sameFile` rule the structured recall uses, so
 * the two axes differ only in which text they scan — no drift in the match rule. NOTE the eval decomposes the two
 * PER LOCUS (drop = analysis-named ∧ ¬structured; synth = structured ∧ ¬analysis-named), not by subtracting totals:
 * `analysisRecall ≥ structuredRecall` is NOT an invariant (the structurer can synthesize a locus-matching path
 * from a vague description the prose never literally names), so a scalar difference could mislead.
 */
export function analysisMentionsLocus(
  analysisText: string,
  locusPath: string
): boolean {
  const tokens = analysisText.match(PATH_TOKEN_RE) ?? [];
  return tokens.some((t) => sameFile(t, locusPath));
}
