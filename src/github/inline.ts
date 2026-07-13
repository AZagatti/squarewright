/**
 * Inline-comment placement. GitHub only accepts a PR review comment on a line that is part of the diff on the
 * RIGHT (new) side — an added or context line. Posting on any other line 422s the WHOLE review, so we map
 * findings to commentable positions and drop (or reroute to the sticky summary) the ones that don't land.
 */
import type { ChangedFile, Finding } from "../core/types.js";
import { renderInlineBody } from "../output/render.js";

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** New-side line numbers that can carry an inline comment (added + context lines) for one file's patch. */
export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const m = HUNK.exec(raw);
    if (m) {
      newLine = Number(m[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    const [c] = raw;
    if (c === "+") {
      lines.add(newLine);
      newLine += 1;
    } else if (c === " ") {
      lines.add(newLine);
      newLine += 1;
    } else if (c === "-") {
      // left-side only; no right-side position, not commentable
    } else {
      // "\ No newline at end of file", or end of hunk
    }
  }
  return lines;
}

export interface InlineComment {
  body: string;
  line: number;
  path: string;
}

/**
 * Map findings to inline comments on commentable lines. Findings that don't land on a commentable line are
 * returned separately so the caller can fold them into the sticky summary instead of dropping them silently.
 */
export function mapToInlineComments(
  findings: Finding[],
  files: ChangedFile[],
  opts: { cap?: number; labelFor?: (source: string) => string } = {}
): { inline: InlineComment[]; unplaceable: Finding[] } {
  const commentable = new Map<string, Set<number>>();
  for (const f of files) {
    if (f.patch) {
      commentable.set(f.path, commentableLines(f.patch));
    }
  }
  const placeable: { comment: InlineComment; finding: Finding }[] = [];
  const unplaceable: Finding[] = [];
  for (const f of findings) {
    const lines = commentable.get(f.path);
    if (lines?.has(f.line)) {
      // inline tags the finding's primary source only (the singular `source`); the sticky shows the full
      // multi-lens set via `sources`, so inline attribution can be less complete than the summary's.
      const lens = f.source ? opts.labelFor?.(f.source) : undefined;
      placeable.push({
        comment: {
          body: renderInlineBody(f.message, lens),
          line: f.line,
          path: f.path,
        },
        finding: f,
      });
    } else {
      unplaceable.push(f);
    }
  }
  // Cap the number of INLINE comments (GitHub + attention limit), but do NOT drop the overflow: findings past the
  // cap fold into `unplaceable` so the sticky still surfaces them, honoring this module's "never drop silently".
  const cap = opts.cap ?? 40;
  const inline = placeable.slice(0, cap).map((p) => p.comment);
  for (const p of placeable.slice(cap)) {
    unplaceable.push(p.finding);
  }
  return { inline, unplaceable };
}
