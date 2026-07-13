/**
 * Read the gather-phase artifact into a `ReviewContext` for the trusted review phase. The gather workflow
 * (untrusted, no secrets) writes the PR's diff + metadata as JSON; this reads it as **data only** — never
 * executed. Because a forged/malformed artifact is attacker-controlled, every field is VALIDATED with zod before
 * use — a wrong-typed value (e.g. a numeric `body`, or `pr-files.json` that isn't an array) must fail here with a
 * clear error, not crash later inside prompt assembly (`ctx.body.trim()`, `files.map(...)`, `defangIssueFence`).
 * Shape is fixed by `templates/workflows/squarewright-gather.yml`:
 *   pr-files.json — the GitHub "list PR files" API array ({ filename, status, patch? })
 *   pr-meta.json  — { number, title, base_sha, head_sha, repo, body }
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ChangedFile, ReviewContext } from "../core/types.js";
import { parseIssueRefs } from "../github/issue-refs.js";

/**
 * Parse-time size ceiling for a gather artifact (#161, defense-in-depth companion to #150's prompt-side caps). The
 * gather workflow is attacker-authorable, and `readFileSync` + `JSON.parse` load the WHOLE file into memory before
 * any zod/#150 cap runs — so a multi-GB forged `pr-files.json` could exhaust the runner at parse time. 50 MB is far
 * above any real gather output (GitHub's own PR-files API omits huge patches), so this only trips a pathological
 * artifact. Read the size FIRST (statSync is O(1)) and refuse before the read allocates.
 */
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const ghFileSchema = z.object({
  filename: z.string(),
  patch: z.string().optional(),
  status: z.string(),
});

const ghMetaSchema = z.object({
  base_sha: z.string(),
  body: z.string().nullish(),
  head_sha: z.string(),
  number: z.number(),
  repo: z.string(),
  title: z.string(),
});

const ghIssueSchema = z.object({
  body: z.string().nullish(),
  number: z.number(),
  title: z.string().nullish(),
});

/** GitHub file statuses that don't map 1:1 (changed/copied/unchanged) collapse to "modified". */
function mapStatus(status: string): ChangedFile["status"] {
  if (status === "added" || status === "removed" || status === "renamed") {
    return status;
  }
  return "modified";
}

/** Read a gather-artifact file as text, refusing before the read allocates if it exceeds `max` bytes (`max` is
 * injectable for testing without a multi-GB fixture). */
export function readCapped(
  path: string,
  max: number = MAX_ARTIFACT_BYTES
): string {
  const { size } = statSync(path);
  if (size > max) {
    throw new Error(
      `gather artifact "${path}" is ${size} bytes, over the ${max}-byte cap — refusing to parse (a real gather output is far smaller).`
    );
  }
  return readFileSync(path, "utf8");
}

/**
 * Read + VALIDATE a REQUIRED gather-artifact file. A missing/unreadable file, invalid JSON, OR a value that
 * doesn't match `schema` all raise the same friendly error — never a raw crash deep in the review path.
 */
function readJson<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readCapped(path));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot read gather artifact "${path}": ${reason}. Run the gather phase first.`,
      { cause: e }
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Malformed gather artifact "${path}": ${parsed.error.message}. Run the gather phase first.`
    );
  }
  return parsed.data;
}

/** Read + VALIDATE an OPTIONAL gather-artifact file: null if it's absent, unreadable, or fails the schema. */
function readJsonOptional<T>(path: string, schema: z.ZodType<T>): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readCapped(path));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The linked issue for the AC-conformance check, if the gather phase fetched one. UNTRUSTED like the rest of the
 * artifact. As a consistency guard we require the fetched issue number to actually be referenced by a closing
 * keyword in the PR body — `parseIssueRefs` — so a stray/mismatched `linked-issue.json` can't silently inject an
 * unrelated issue's text into the review. Returns undefined when absent, unreferenced, or malformed.
 */
function readLinkedIssue(
  dir: string,
  prBody: string
): ReviewContext["linkedIssue"] {
  const iss = readJsonOptional(join(dir, "linked-issue.json"), ghIssueSchema);
  if (!iss) {
    return;
  }
  if (!parseIssueRefs(prBody).includes(iss.number)) {
    return; // the PR body doesn't declare it closes this issue — drop it (consistency guard)
  }
  return { body: iss.body ?? "", number: iss.number, title: iss.title ?? "" };
}

/** Build a `ReviewContext` from a gather-artifact directory. */
export function readGatherArtifact(dir: string): ReviewContext {
  const meta = readJson(join(dir, "pr-meta.json"), ghMetaSchema);
  const files: ChangedFile[] = readJson(
    join(dir, "pr-files.json"),
    z.array(ghFileSchema)
  ).map((f) => ({
    patch: f.patch,
    path: f.filename,
    status: mapStatus(f.status),
  }));

  const body = meta.body ?? "";
  return {
    baseSha: meta.base_sha,
    body,
    files,
    headSha: meta.head_sha,
    linkedIssue: readLinkedIssue(dir, body),
    prNumber: meta.number,
    repo: meta.repo,
    title: meta.title,
  };
}
