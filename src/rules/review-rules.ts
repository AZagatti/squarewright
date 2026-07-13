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
import { parse as parseYaml } from "yaml";
import { matchGlob } from "../personas/routing.js";
import type { RepoReader } from "../pi/session.js";

/** The directory (repo-relative) that holds Tier-A rule files. */
export const REVIEW_RULES_DIR = ".review-rules";

const ENTRY_RE = /^([d-])\s+(.+)$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

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

/**
 * The `globs` value from a parsed frontmatter mapping, as a list of strings. A BARE STRING is coerced to a
 * one-element list: `globs: "src/x/**"` (scalar) is the obvious way a maintainer scopes a rule, and silently
 * dropping it to `[]` would promote the rule to "applies to every PR" (empty globs = unscoped) — injecting a
 * file-scoped, possibly PERMISSIVE rule repo-wide, where it could suppress findings on unrelated PRs. An array
 * keeps only its real string entries; anything else (number, mapping, null) yields `[]` (the unscoped default).
 */
function normalizeGlobs(raw: unknown): string[] {
  if (typeof raw === "string") {
    return [raw];
  }
  return Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === "string")
    : [];
}

/**
 * Split a leading `--- … ---` YAML frontmatter block from the markdown body — using a REAL YAML parser, not a
 * line heuristic. The fenced block is frontmatter only when it parses as a YAML MAPPING: a rule body that merely
 * opens with a `---` divider then prose parses as a string, a `- item` bullet list parses as an array, and mixed
 * content (`Note:` sentence + bullets) is invalid YAML — all three throw or yield a non-mapping, so we keep the
 * whole file as body instead of silently truncating it. Only `globs` is read; everything else is ignored.
 */
function parseFrontmatter(content: string): { body: string; globs: string[] } {
  const fence = FRONTMATTER_RE.exec(content);
  if (!fence) {
    return { body: content.trim(), globs: [] };
  }
  let doc: unknown;
  try {
    doc = parseYaml(fence[1] as string);
  } catch {
    return { body: content.trim(), globs: [] };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { body: content.trim(), globs: [] };
  }
  return {
    body: content.slice(fence[0].length).trim(),
    globs: normalizeGlobs((doc as { globs?: unknown }).globs),
  };
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
