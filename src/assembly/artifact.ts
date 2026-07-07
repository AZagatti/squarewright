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

  return {
    baseSha: meta.base_sha,
    body: meta.body ?? "",
    files,
    headSha: meta.head_sha,
    prNumber: meta.number,
    repo: meta.repo,
    title: meta.title,
  };
}
