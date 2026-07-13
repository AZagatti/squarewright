/**
 * Read the gather-phase artifact into a `ReviewContext` for the trusted review phase. The gather workflow
 * (untrusted, no secrets) writes the PR's diff + metadata as JSON; this reads it as **data only** — never
 * executed. Shape is fixed by `templates/workflows/squarewright-gather.yml`:
 *   pr-files.json — the GitHub "list PR files" API array ({ filename, status, patch? })
 *   pr-meta.json  — { number, title, base_sha, head_sha, repo, body }
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangedFile, ReviewContext } from "../core/types.js";
import { parseIssueRefs } from "../github/issue-refs.js";

interface GhFile {
  filename: string;
  patch?: string;
  status: string;
}

interface GhMeta {
  base_sha: string;
  body: string | null;
  head_sha: string;
  number: number;
  repo: string;
  title: string;
}

/** GitHub file statuses that don't map 1:1 (changed/copied/unchanged) collapse to "modified". */
function mapStatus(status: string): ChangedFile["status"] {
  if (status === "added" || status === "removed" || status === "renamed") {
    return status;
  }
  return "modified";
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot read gather artifact "${path}": ${reason}. Run the gather phase first.`,
      { cause: e }
    );
  }
}

/** Read an OPTIONAL gather-artifact file: returns null if it doesn't exist (vs `readJson`, which requires it). */
function readJsonOptional<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface GhIssue {
  body?: string | null;
  number: number;
  title?: string | null;
}

/**
 * The linked issue for the AC-conformance check, if the gather phase fetched one. UNTRUSTED like the rest of the
 * artifact. As a consistency guard we require the fetched issue number to actually be referenced by a closing
 * keyword in the (trusted-shape) PR body — `parseIssueRefs` — so a stray/mismatched `linked-issue.json` can't
 * silently inject an unrelated issue's text into the review. Returns undefined when absent or unreferenced.
 */
function readLinkedIssue(
  dir: string,
  prBody: string
): ReviewContext["linkedIssue"] {
  const iss = readJsonOptional<GhIssue>(join(dir, "linked-issue.json"));
  if (!iss || typeof iss.number !== "number") {
    return;
  }
  if (!parseIssueRefs(prBody).includes(iss.number)) {
    return; // the PR body doesn't declare it closes this issue — drop it (consistency guard)
  }
  return { body: iss.body ?? "", number: iss.number, title: iss.title ?? "" };
}

/** Build a `ReviewContext` from a gather-artifact directory. */
export function readGatherArtifact(dir: string): ReviewContext {
  const meta = readJson<GhMeta>(join(dir, "pr-meta.json"));
  const files: ChangedFile[] = readJson<GhFile[]>(
    join(dir, "pr-files.json")
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
