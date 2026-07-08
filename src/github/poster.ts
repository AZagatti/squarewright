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
import { STICKY_MARKER } from "../output/render.js";
import type { LookupPullsForCommit, VerifiedTarget } from "../safety/trust.js";
import type { InlineComment } from "./inline.js";

/** Runs `gh <args>`, optionally writing `input` to stdin; resolves with the exit code and captured streams. */
export type GhRunner = (
  args: string[],
  input?: string
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Every GitHub write goes through here; the location is always a trust-checked `VerifiedTarget`. */
export interface Poster {
  /** Post the inline findings as one atomic PR review (no-op when there are none). */
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

/** The id of the existing sticky comment on the PR, or null if none has been posted yet. */
async function findStickyId(
  run: GhRunner,
  target: VerifiedTarget
): Promise<number | null> {
  const stdout = await ghApi(run, [
    `repos/${target.repo}/issues/${target.prNumber}/comments`,
    "--paginate",
  ]);
  const comments = JSON.parse(stdout) as { body: string; id: number }[];
  const found = comments.find((c) => c.body.startsWith(STICKY_MARKER));
  return found ? found.id : null;
}

/** A `Poster` backed by the `gh` CLI, driven through the injected `run`. */
export function createGhPoster(run: GhRunner): Poster {
  return {
    postReview: async (target, inline) => {
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
 * commit is `sha` in `repo`, authenticated against that trusted repo+sha.
 */
export function createGhPullLookup(run: GhRunner): LookupPullsForCommit {
  return async (repo, sha) => {
    const stdout = await ghApi(run, [
      `repos/${repo}/commits/${sha}/pulls`,
      "--paginate",
    ]);
    const pulls = JSON.parse(stdout) as { number: number; state: string }[];
    return pulls
      .filter((p) => p.state === "open")
      .map((p) => ({
        number: p.number,
      }));
  };
}

/** The real subprocess runner: portable across Node and Bun; used by the CLI to construct the gh-backed Poster. */
export const ghRunner: GhRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
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
