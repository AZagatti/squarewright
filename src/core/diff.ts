/**
 * Minimal unified-diff parsing into per-file entries. Used by the eval runner over frozen golden diffs and the
 * dev/spike scripts (the production review path reads path/status straight from the GitHub API JSON, not from
 * here). Parsing must survive the real shapes `git`/`gh` emit: renames, mode-only changes, binary files, and
 * quoted paths (`core.quotepath`) — all of which lack the `---`/`+++` lines and would otherwise fall through.
 */
import type { ChangedFile } from "./types.js";

const FILE_SPLIT_RE = /^diff --git /m;
// All anchored at line start (`^` in multiline) so ordinary hunk content — every real content line is prefixed
// with `+`/`-`/space — can never spuriously match these header keywords (the old `body.includes(...)` did).
const NEW_PATH_RE = /^\+\+\+ (.+)$/m;
const OLD_PATH_RE = /^--- (.+)$/m;
const RENAME_TO_RE = /^rename to (.+)$/m;
const COPY_TO_RE = /^copy to (.+)$/m;
const GIT_HEADER_RE = /^diff --git (.+)$/m;
const NEW_FILE_RE = /^new file mode /m;
const DELETED_FILE_RE = /^deleted file mode /m;
const RENAME_OR_COPY_RE = /^(?:rename|copy) (?:from|to) /m;
const OCTAL_DIGIT_RE = /[0-7]/;
const AB_PREFIX_RE = /^[ab]\//;
const HEADER_B_RE = / b\/(.+)$/;
const HEADER_B_LOOSE_RE = /b\/(\S+)/;

/** Decode git's `core.quotepath` octal byte escapes (`caf\303\251` → `café`); pass plain ASCII through unchanged. */
function decodeOctal(s: string): string {
  if (!s.includes("\\")) {
    return s;
  }
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\" && OCTAL_DIGIT_RE.test(s[i + 1] ?? "")) {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push((ch ?? "").charCodeAt(0));
    }
  }
  try {
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return s;
  }
}

/**
 * Normalize a raw path token from a diff header: drop the trailing disambiguation tab git appends to paths with
 * spaces, unwrap the double-quotes git adds for special/non-ASCII paths (decoding its octal escapes), and strip
 * the `a/`/`b/` prefix. Returns null for `/dev/null` (the absent side of an add/delete).
 */
function cleanPath(raw: string): string | null {
  let p = raw.trim();
  const tab = p.indexOf("\t");
  if (tab >= 0) {
    p = p.slice(0, tab);
  }
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    p = decodeOctal(p.slice(1, -1));
  }
  if (p === "/dev/null") {
    return null;
  }
  return p.replace(AB_PREFIX_RE, "") || null;
}

/**
 * The new-side path, from the most reliable source available: the `+++` line, then a rename/copy target, then the
 * `---` (old) side for deletes, then a best-effort parse of the `diff --git a/… b/…` header — the only line a
 * pure rename, a mode-only change, or a binary file carries. `(unknown)` only if all of those fail.
 */
function resolveNewPath(body: string): string {
  for (const raw of [
    NEW_PATH_RE.exec(body)?.[1],
    RENAME_TO_RE.exec(body)?.[1],
    COPY_TO_RE.exec(body)?.[1],
    OLD_PATH_RE.exec(body)?.[1],
  ]) {
    const cleaned = raw ? cleanPath(raw) : null;
    if (cleaned) {
      return cleaned;
    }
  }
  const header = GIT_HEADER_RE.exec(body)?.[1];
  const b =
    header?.match(HEADER_B_RE)?.[1] ?? header?.match(HEADER_B_LOOSE_RE)?.[1];
  return (b ? cleanPath(`b/${b}`) : null) ?? "(unknown)";
}

function resolveStatus(body: string): ChangedFile["status"] {
  if (NEW_FILE_RE.test(body)) {
    return "added";
  }
  if (DELETED_FILE_RE.test(body)) {
    return "removed";
  }
  if (RENAME_OR_COPY_RE.test(body)) {
    return "renamed";
  }
  return "modified";
}

/** Split a unified diff into per-file ChangedFile entries keyed by new-side path. */
export function splitUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const chunks = diff.split(FILE_SPLIT_RE).filter((c) => c.trim());
  for (const chunk of chunks) {
    const body = `diff --git ${chunk}`;
    files.push({
      patch: body,
      path: resolveNewPath(body),
      status: resolveStatus(body),
    });
  }
  return files;
}
