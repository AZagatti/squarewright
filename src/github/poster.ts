/**
 * The `Poster` — the single seam every GitHub write goes through (AGENTS.md). Its location argument is always a
 * `VerifiedTarget` from the trust check, so the Poster is structurally incapable of posting to an unvalidated
 * repo/PR/SHA. The first implementation shells out to `gh api` (auth, pagination, and retries handled by the
 * CLI, which is pre-installed on GitHub runners where posting runs). The subprocess is injected as a `GhRunner`,
 * so the logic is unit-testable without `gh` and the transport is swappable (e.g. to Octokit) behind this seam.
 *
 * Untrusted comment/summary text is sent as a JSON body over stdin (`--input -`), never interpolated as a shell
 * argument — `spawn` uses no shell, and `JSON.stringify` encodes the payload, so there is no injection surface.
 */
import { spawn } from "node:child_process";
import { INLINE_MARKER, STICKY_MARKER } from "../output/render.js";
import type { LookupPullsForCommit, VerifiedTarget } from "../safety/trust.js";
import type { InlineComment } from "./inline.js";

/** Runs `gh <args>`, optionally writing `input` to stdin; resolves with the exit code and captured streams. */
export type GhRunner = (
  args: string[],
  input?: string
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Every GitHub write goes through here; the location is always a trust-checked `VerifiedTarget`. */
export interface Poster {
  /**
   * Post a standalone PR comment (teach-by-reply rule suggestion, ADR-0005 §3). Unlike `upsertSticky` this does
   * NOT replace a prior comment — each accepted teach reply earns its own suggestion (the workflow fires once per
   * comment, so there's no natural duplication). Takes only `repo`+`prNumber` (a `VerifiedTarget` satisfies it):
   * a comment isn't pinned to a commit, and teach's trusted target carries no `commitSha`.
   */
  postComment: (
    target: Pick<VerifiedTarget, "prNumber" | "repo">,
    body: string
  ) => Promise<void>;
  /**
   * Make the PR's inline review reflect exactly `inline`: delete our prior inline comments (so a re-review
   * replaces, never accumulates), then post the current set as one atomic review. Clears even when `inline` is
   * empty, so a now-clean PR drops its stale inline comments.
   */
  postReview: (
    target: VerifiedTarget,
    inline: InlineComment[]
  ) => Promise<void>;
  /** Create or update (in place) the single sticky summary comment. */
  upsertSticky: (target: VerifiedTarget, body: string) => Promise<void>;
}

async function ghApi(
  run: GhRunner,
  apiArgs: string[],
  input?: string
): Promise<string> {
  const { code, stdout, stderr } = await run(["api", ...apiArgs], input);
  if (code !== 0) {
    throw new Error(
      `gh api ${apiArgs.join(" ")} failed (exit ${code}): ${stderr.trim()}`
    );
  }
  return stdout;
}

/** Parse `gh` JSON output, rethrowing with the endpoint so a malformed response isn't an unattributed error. */
function parseJson<T>(stdout: string, endpoint: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (e) {
    throw new Error(
      `gh api ${endpoint} returned unparseable JSON: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
}

/** The id of the existing sticky comment on the PR, or null if none has been posted yet. */
async function findStickyId(
  run: GhRunner,
  target: VerifiedTarget
): Promise<number | null> {
  const endpoint = `repos/${target.repo}/issues/${target.prNumber}/comments`;
  const stdout = await ghApi(run, [endpoint, "--paginate"]);
  const comments = parseJson<{ body: string; id: number }[]>(stdout, endpoint);
  const found = comments.find((c) => c.body.startsWith(STICKY_MARKER));
  return found ? found.id : null;
}

/** Delete our prior inline comments (the ones carrying `INLINE_MARKER`), leaving any human/other comments. */
async function clearPriorInline(
  run: GhRunner,
  target: VerifiedTarget
): Promise<void> {
  const endpoint = `repos/${target.repo}/pulls/${target.prNumber}/comments`;
  const stdout = await ghApi(run, [endpoint, "--paginate"]);
  const comments = parseJson<{ body: string; id: number }[]>(stdout, endpoint);
  // startsWith (not includes): a human "Quote reply" prefixes the quoted marker with `> `, so it won't match
  const ours = comments.filter((c) => c.body.startsWith(INLINE_MARKER));
  await Promise.all(
    ours.map((c) =>
      ghApi(run, [
        `repos/${target.repo}/pulls/comments/${c.id}`,
        "--method",
        "DELETE",
      ])
    )
  );
}

/** A `Poster` backed by the `gh` CLI, driven through the injected `run`. */
export function createGhPoster(run: GhRunner): Poster {
  return {
    postComment: async (target, body) => {
      const payload = JSON.stringify({ body });
      await ghApi(
        run,
        [
          `repos/${target.repo}/issues/${target.prNumber}/comments`,
          "--method",
          "POST",
          "--input",
          "-",
        ],
        payload
      );
    },
    postReview: async (target, inline) => {
      // replace, never accumulate: drop our prior inline comments before posting the current set
      await clearPriorInline(run, target);
      if (inline.length === 0) {
        return;
      }
      const payload = JSON.stringify({
        comments: inline.map((c) => ({
          body: c.body,
          line: c.line,
          path: c.path,
          side: "RIGHT",
        })),
        commit_id: target.commitSha,
        event: "COMMENT",
      });
      await ghApi(
        run,
        [
          `repos/${target.repo}/pulls/${target.prNumber}/reviews`,
          "--method",
          "POST",
          "--input",
          "-",
        ],
        payload
      );
    },
    upsertSticky: async (target, body) => {
      const payload = JSON.stringify({ body });
      const existing = await findStickyId(run, target);
      const apiArgs =
        existing === null
          ? [`repos/${target.repo}/issues/${target.prNumber}/comments`]
          : [`repos/${target.repo}/issues/comments/${existing}`];
      await ghApi(
        run,
        [
          ...apiArgs,
          "--method",
          existing === null ? "POST" : "PATCH",
          "--input",
          "-",
        ],
        payload
      );
    },
  };
}

/**
 * A `LookupPullsForCommit` (the trust check's injected dependency) backed by `gh`. Lists OPEN PRs whose head
 * commit is `sha` in `repo`, queried using the trusted repo+sha (auth is ambient via `gh`'s own token).
 */
export function createGhPullLookup(run: GhRunner): LookupPullsForCommit {
  return async (repo, sha) => {
    const endpoint = `repos/${repo}/commits/${sha}/pulls`;
    const stdout = await ghApi(run, [endpoint, "--paginate"]);
    const pulls = parseJson<{ number: number; state: string }[]>(
      stdout,
      endpoint
    );
    return pulls
      .filter((p) => p.state === "open")
      .map((p) => ({ number: p.number }));
  };
}

/** Build a `GhRunner` that shells out to `bin`. Portable across Node and Bun; `bin` is a fixed binary, never
 * PR-derived, so there is no injection surface. Parameterized by binary so the subprocess contract can be
 * exercised in tests with a trivial command. */
export function spawnRunner(bin: string): GhRunner {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
      if (input !== undefined) {
        child.stdin.write(input);
      }
      child.stdin.end();
    });
}

/** The real subprocess runner used by the CLI to construct the gh-backed Poster. */
export const ghRunner: GhRunner = spawnRunner("gh");
