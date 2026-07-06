/**
 * Minimal unified-diff parsing into per-file entries. Used by the review harness (to turn a gather
 * artifact / `gh pr diff` into a ReviewContext) and by the eval runner over frozen golden diffs.
 */
import type { ChangedFile } from "./types.js";

/** Split a unified diff into per-file ChangedFile entries keyed by new-side path. */
export function splitUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const chunks = diff.split(/^diff --git /m).filter((c) => c.trim());
  for (const chunk of chunks) {
    const body = `diff --git ${chunk}`;
    const plus = body.match(/^\+\+\+ b\/(.+)$/m);
    const minus = body.match(/^--- a\/(.+)$/m);
    const path = plus?.[1] ?? minus?.[1] ?? "(unknown)";
    const status: ChangedFile["status"] = body.includes("new file mode")
      ? "added"
      : body.includes("deleted file mode")
        ? "removed"
        : "modified";
    files.push({ path, status, patch: body });
  }
  return files;
}
