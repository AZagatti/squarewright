/**
 * Tier-A project rules loader (ADR-0005, M6). Reads `.review-rules/*.md` — maintainer-authored, glob-scoped
 * conventions — and DETERMINISTICALLY (zero LLM) selects the ones relevant to a PR's changed files, reusing the
 * persona glob matcher. Matched rule text is injected into the review prompts as trusted, precedence-taking
 * project context. No LLM decides anything here: a human authored the rules and a human edits them.
 *
 * TRUST BOUNDARY (Hard Rule #1): these rules are trusted only when they come from an already-reviewed revision.
 * The production wiring MUST supply a `RepoReader` bound to the **base** (merged) tree, never the PR head — a
 * head-revision rule file added by an untrusted PR could silently suppress findings ("ignore all security
 * issues"). This module is pure over an injected reader; choosing a base-revision reader is the caller's job.
 */
import { matchGlob } from "../personas/routing.js";
import type { RepoReader } from "../pi/session.js";

/** The directory (repo-relative) that holds Tier-A rule files. */
export const REVIEW_RULES_DIR = ".review-rules";

const ENTRY_RE = /^([d-])\s+(.+)$/;
const GLOBS_KEY_RE = /^globs\s*:/;
const LIST_ITEM_RE = /^\s*-\s*(.+)$/;
const LEADING_BRACKET_RE = /^\[/;
const TRAILING_BRACKET_RE = /\].*$/;
const LEADING_QUOTE_RE = /^["']/;
const TRAILING_QUOTE_RE = /["']$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const NEWLINE_RE = /\r?\n/;

/** One maintainer-authored rule file: its path, its glob scope, and its (frontmatter-stripped) body. */
export interface ReviewRule {
  /** the rule body with frontmatter removed — injected verbatim */
  body: string;
  /** file globs from frontmatter; an empty list => the rule applies to every PR */
  globs: string[];
  /** repo-relative path of the rule file, e.g. ".review-rules/architecture.md" */
  path: string;
}

/** Split a `list_repo_dir` entry (`"- name"` / `"d name"`, or a bare basename) into its name + dir flag. */
function parseEntry(entry: string): { isDir: boolean; name: string } {
  const marked = ENTRY_RE.exec(entry);
  if (marked) {
    return { isDir: marked[1] === "d", name: marked[2] as string };
  }
  return { isDir: false, name: entry };
}

function stripQuotes(raw: string): string {
  return raw.replace(LEADING_QUOTE_RE, "").replace(TRAILING_QUOTE_RE, "");
}

/** Parse a `globs:` frontmatter value — inline `["a", "b"]` or a following `- item` block list. */
function parseGlobs(frontmatterLines: string[]): string[] {
  const idx = frontmatterLines.findIndex((l) => GLOBS_KEY_RE.test(l));
  if (idx === -1) {
    return [];
  }
  const line = frontmatterLines[idx] as string;
  const after = line.slice(line.indexOf(":") + 1).trim();
  if (after.startsWith("[")) {
    const inner = after
      .replace(LEADING_BRACKET_RE, "")
      .replace(TRAILING_BRACKET_RE, "");
    return inner
      .split(",")
      .map((x) => stripQuotes(x.trim()))
      .filter(Boolean);
  }
  const out: string[] = [];
  for (let i = idx + 1; i < frontmatterLines.length; i += 1) {
    const item = LIST_ITEM_RE.exec(frontmatterLines[i] as string);
    if (!item) {
      break;
    }
    out.push(stripQuotes((item[1] as string).trim()));
  }
  return out;
}

/** Split leading `--- ... ---` YAML frontmatter (if any) from the markdown body. */
function parseFrontmatter(content: string): { body: string; globs: string[] } {
  const fence = FRONTMATTER_RE.exec(content);
  if (!fence) {
    return { body: content.trim(), globs: [] };
  }
  const globs = parseGlobs((fence[1] as string).split(NEWLINE_RE));
  return { body: content.slice(fence[0].length).trim(), globs };
}

/**
 * Load every rule under `.review-rules/`. Returns `[]` when the directory is absent (not an error — most repos
 * won't have one). README.md is skipped (it documents the format; it isn't a rule). Rules with an empty body
 * are dropped. Entries are read in sorted order for a stable, reproducible prompt.
 */
export async function loadReviewRules(
  reader: RepoReader,
  dir: string = REVIEW_RULES_DIR
): Promise<ReviewRule[]> {
  const entries = await reader.listDir(dir);
  if (!entries) {
    return [];
  }
  const names = entries
    .map(parseEntry)
    .filter(
      (e) =>
        !e.isDir &&
        e.name.toLowerCase().endsWith(".md") &&
        e.name.toLowerCase() !== "readme.md"
    )
    .map((e) => e.name)
    .sort();

  const rules: ReviewRule[] = [];
  for (const name of names) {
    const path = `${dir}/${name}`;
    // biome-ignore lint/performance/noAwaitInLoops: a handful of small local files; sequential keeps it simple + ordered
    const content = await reader.readFile(path);
    if (content === null) {
      continue;
    }
    const { body, globs } = parseFrontmatter(content);
    if (body) {
      rules.push({ body, globs, path });
    }
  }
  return rules;
}

/** Select the rules relevant to this change-set: any glob matches a changed path, or the rule has no globs. */
export function selectReviewRules(
  rules: ReviewRule[],
  changedPaths: string[]
): ReviewRule[] {
  return rules.filter(
    (r) =>
      r.globs.length === 0 ||
      r.globs.some((g) => changedPaths.some((p) => matchGlob(g, p)))
  );
}

/**
 * Render the selected rules as a precedence-framed preamble to prepend to a persona prompt. Empty string when
 * there are no rules, so the caller can prepend unconditionally without changing a no-rules review.
 */
export function renderReviewRules(rules: ReviewRule[]): string {
  if (rules.length === 0) {
    return "";
  }
  const blocks = rules.map((r) => `### ${r.path}\n${r.body}`).join("\n\n");
  return (
    "## Project review rules (trusted, maintainer-authored)\n" +
    "These project-specific rules take precedence over any conflicting guidance in your checklist below. " +
    "A rule that explicitly permits something you would otherwise flag wins — do not flag it.\n\n" +
    `${blocks}\n\n---\n\n`
  );
}
