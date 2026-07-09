/**
 * Tier-B background docs (ADR-0005 §1). DETERMINISTIC, zero-LLM: given the `.squarewright.yml` `contextDocs`
 * specs (each maps changed-file globs → an existing doc path like `AGENTS.md`/`docs/…`), read the docs whose
 * globs match the PR's changed files from the trusted base checkout and inject them as **background context** —
 * below Tier-A `.review-rules`, which take precedence. This pulls in docs the maintainer already wrote without
 * rewriting them as rules. It reuses the persona glob matcher and the same trusted `RepoReader` as Tier A, so it
 * adds no new trust surface and keeps grounding off (no model-driven repo reads).
 */
import { matchGlob } from "../personas/routing.js";
import type { RepoReader } from "../pi/session.js";

/** A config-declared doc pointer: include `path` as context when a changed file matches any of `globs`. */
export interface ContextDocSpec {
  globs: string[];
  path: string;
}

/** A loaded background doc: its repo-relative path and full text. */
export interface ContextDoc {
  body: string;
  path: string;
}

/**
 * Load the specs whose globs match a changed file, reading each doc via the trusted reader. Specs with no globs
 * match nothing (a background doc must declare when it applies). A doc that reads back null/empty is skipped.
 * Deduped by path (a doc referenced by two matching specs is injected once), in first-declared order.
 */
export async function loadContextDocs(
  reader: RepoReader,
  specs: ContextDocSpec[],
  changedPaths: string[]
): Promise<ContextDoc[]> {
  const seen = new Set<string>();
  const docs: ContextDoc[] = [];
  for (const spec of specs) {
    if (seen.has(spec.path)) {
      continue;
    }
    const matches = spec.globs.some((g) =>
      changedPaths.some((p) => matchGlob(g, p))
    );
    if (!matches) {
      continue;
    }
    seen.add(spec.path);
    // biome-ignore lint/performance/noAwaitInLoops: a handful of small declared docs; sequential keeps order stable
    const body = await reader.readFile(spec.path);
    if (body?.trim()) {
      docs.push({ body: body.trim(), path: spec.path });
    }
  }
  return docs;
}

/**
 * Render the loaded docs as a background-context preamble. Empty string when there are none, so the caller can
 * prepend unconditionally. Framed as background (NOT precedence) — Tier-A rules override, these merely inform.
 */
export function renderContextDocs(docs: ContextDoc[]): string {
  if (docs.length === 0) {
    return "";
  }
  const blocks = docs.map((d) => `### ${d.path}\n${d.body}`).join("\n\n");
  return (
    "## Project docs (background context)\n" +
    "These are the project's own docs, for context on its conventions and architecture. They inform your " +
    "review but do not override your checklist; where a `.review-rules` project rule conflicts, the rule wins.\n\n" +
    `${blocks}\n\n---\n\n`
  );
}
