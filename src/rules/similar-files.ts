/**
 * Project-pattern alignment (EVAL-ONLY pilot, 2026-07-13 council). DETERMINISTIC, zero-LLM, zero-config: for each
 * changed file, pick a few EXISTING sibling files with the same apparent intent (same directory, same extension,
 * most name-related) and inject them as reference context, so the reviewer can judge whether the diff aligns with
 * how this codebase already handles related code — instead of judging in the abstract.
 *
 * Deliberately NOT the agentic grounding that collapsed precision: the model gets no repo-read tools and no say in
 * WHAT it sees — selection is a fixed heuristic over the trusted base-revision `RepoReader`, bounded tightly (a
 * couple of files, capped size), mirroring the Tier-A/Tier-B `.review-rules`/`contextDocs` injection pattern. Wired
 * behind `eval.ts --similar-files` only; NOT on the production path until the measurement clears its bar.
 */
import type { RepoReader } from "../pi/session.js";

/** A reference sibling file: its repo-relative path and (size-capped) text. */
export interface SimilarFile {
  body: string;
  path: string;
}

const TOKEN_RE = /[^a-z0-9]+/i;

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}
function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i) : "";
}
/** Filename tokens (minus the extension), for a cheap same-intent relevance score. */
function nameTokens(name: string): Set<string> {
  const stem = name.slice(0, name.length - extOf(name).length);
  return new Set(stem.split(TOKEN_RE).filter((t) => t.length > 1));
}
function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) {
    if (b.has(t)) {
      n += 1;
    }
  }
  return n;
}

/**
 * Load up to `total` sibling files across all changed paths. For each changed file, siblings are same-directory,
 * same-extension files NOT in the diff, ranked by shared filename tokens (then name, for a stable deterministic
 * order), and the top `perFile` are read. Bounded and dedup'd; a file that reads back empty is skipped.
 */
export async function loadSimilarFiles(
  reader: RepoReader,
  changedPaths: string[],
  opts: { perFile?: number; total?: number; maxChars?: number } = {}
): Promise<SimilarFile[]> {
  const perFile = opts.perFile ?? 2;
  const total = opts.total ?? 4;
  const maxChars = opts.maxChars ?? 4000;
  const changed = new Set(changedPaths);
  const seen = new Set<string>();
  const out: SimilarFile[] = [];

  for (const path of changedPaths) {
    if (out.length >= total) {
      break;
    }
    const dir = dirOf(path);
    const ext = extOf(baseOf(path));
    if (!ext) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one listing per changed file, bounded by the diff's file count
    const entries = await reader.listDir(dir);
    if (!entries) {
      continue;
    }
    const wantTokens = nameTokens(baseOf(path));
    const siblings = entries
      .filter((e) => e.startsWith("- "))
      .map((e) => e.slice(2))
      .filter((name) => extOf(name) === ext && name !== baseOf(path))
      .map((name) => (dir ? `${dir}/${name}` : name))
      .filter((p) => !(changed.has(p) || seen.has(p)))
      .sort((a, b) => {
        const d =
          shared(nameTokens(baseOf(b)), wantTokens) -
          shared(nameTokens(baseOf(a)), wantTokens);
        return d === 0 ? a.localeCompare(b) : d;
      });

    let picked = 0;
    for (const sib of siblings) {
      if (picked >= perFile || out.length >= total) {
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: reads at most `perFile` small files per changed path
      const body = await reader.readFile(sib);
      if (body?.trim()) {
        out.push({ body: body.trim().slice(0, maxChars), path: sib });
        seen.add(sib);
        picked += 1;
      }
    }
  }
  return out;
}

/** Render the reference siblings as a preamble. Empty string when there are none, so the caller can prepend it unconditionally. */
export function renderSimilarFiles(files: SimilarFile[]): string {
  if (files.length === 0) {
    return "";
  }
  const blocks = files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.body}\n\`\`\``)
    .join("\n\n");
  return (
    "## Similar files in this project (reference — how this codebase handles related code)\n" +
    "These EXISTING files are NOT part of the diff. Use them only as a reference for the project's own " +
    "conventions: judge whether the changed code aligns with how similar code here is written — a hunk that " +
    "silently breaks a security- or correctness-relevant pattern its siblings uphold is a finding worth raising. " +
    "Do NOT report pre-existing issues in these reference files; they are context, not under review.\n\n" +
    `${blocks}\n\n---\n\n`
  );
}

/** Convenience for callers: load + render in one step (empty string when nothing similar is found). */
export async function similarFilesPreamble(
  reader: RepoReader,
  changedPaths: string[],
  opts?: { perFile?: number; total?: number; maxChars?: number }
): Promise<string> {
  return renderSimilarFiles(await loadSimilarFiles(reader, changedPaths, opts));
}
