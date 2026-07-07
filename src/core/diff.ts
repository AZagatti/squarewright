/**
 * Minimal unified-diff parsing into per-file entries. Used by the review harness (to turn a gather
 * artifact / `gh pr diff` into a ReviewContext) and by the eval runner over frozen golden diffs.
 */
import type { ChangedFile } from "./types.js";

const FILE_SPLIT_RE = /^diff --git /m;
const NEW_PATH_RE = /^\+\+\+ b\/(.+)$/m;
const OLD_PATH_RE = /^--- a\/(.+)$/m;

/** Split a unified diff into per-file ChangedFile entries keyed by new-side path. */
export function splitUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const chunks = diff.split(FILE_SPLIT_RE).filter((c) => c.trim());
  for (const chunk of chunks) {
    const body = `diff --git ${chunk}`;
    const plus = body.match(NEW_PATH_RE);
    const minus = body.match(OLD_PATH_RE);
    const path = plus?.[1] ?? minus?.[1] ?? "(unknown)";
    let status: ChangedFile["status"];
    if (body.includes("new file mode")) {
      status = "added";
    } else if (body.includes("deleted file mode")) {
      status = "removed";
    } else {
      status = "modified";
    }
    files.push({ patch: body, path, status });
  }
  return files;
}
