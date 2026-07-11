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
