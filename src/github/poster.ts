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
   * Make the PR's inline review reflect exactly `inline`: post the current set as one atomic review, then delete
   * our prior inline comments (so a re-review replaces, never accumulates). Posting BEFORE deleting means a failed
   * post never leaves the PR with zero of our comments. Clears even when `inline` is empty, so a now-clean PR drops
   * its stale inline comments.
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

/** A PR comment as returned by the GitHub list endpoints — `user.login` is the TRUE authenticated author. */
interface GhComment {
  body: string;
  id: number;
  user?: { login?: string };
}

/**
 * Is this a comment WE may edit/delete? It must carry `marker` AND — when we know our own login — be authored by
 * us. `selfLogin` unknown (a hand-rolled workflow with no `SQUAREWRIGHT_BOT_LOGIN`) falls back to marker-only, i.e.
 * EXACTLY today's behavior — fail-SAFE (never worse than before; refusing would be a self-inflicted outage). The
 * author guard closes the hijack in issue #157: a third party can forge our marker but NOT our `user.login` (GitHub
 * sets it to the real authenticated actor), so a decoy comment they post is no longer PATCH-hijacked or deleted.
 * Login compare is case-insensitive (GitHub logins are), matching `src/safety/trust.ts`.
 */
function isOurComment(
  c: GhComment,
  marker: string,
  selfLogin?: string
): boolean {
  if (!c.body.startsWith(marker)) {
    return false;
  }
  if (!selfLogin) {
    return true;
  }
  return c.user?.login?.toLowerCase() === selfLogin.toLowerCase();
}

/** The id of the existing sticky comment on the PR, or null if none we authored has been posted yet. */
async function findStickyId(
  run: GhRunner,
  target: VerifiedTarget,
  selfLogin?: string
): Promise<number | null> {
  const endpoint = `repos/${target.repo}/issues/${target.prNumber}/comments`;
  const stdout = await ghApi(run, [endpoint, "--paginate"]);
  const comments = parseJson<GhComment[]>(stdout, endpoint);
  const found = comments.find((c) => isOurComment(c, STICKY_MARKER, selfLogin));
  return found ? found.id : null;
}

/** The ids of OUR prior inline comments (carry `INLINE_MARKER` + authored by us), captured BEFORE we post anew. */
async function priorInlineIds(
  run: GhRunner,
  target: VerifiedTarget,
  selfLogin?: string
): Promise<number[]> {
  const endpoint = `repos/${target.repo}/pulls/${target.prNumber}/comments`;
  const stdout = await ghApi(run, [endpoint, "--paginate"]);
  const comments = parseJson<GhComment[]>(stdout, endpoint);
  // startsWith (not includes): a human "Quote reply" prefixes the quoted marker with `> `, so it won't match
  return comments
    .filter((c) => isOurComment(c, INLINE_MARKER, selfLogin))
    .map((c) => c.id);
}

/**
 * Delete the given prior inline comments by id, best-effort. `allSettled` (not `all`) so one failed delete — a
 * comment a human already removed, a transient 5xx — doesn't abort the rest, and a leftover stale comment (the
 * worst case here) is cosmetic, never data loss. Deleting by CAPTURED ids (not a re-list) is what lets us post the
 * new review first: the new comments carry the same marker, so a re-list would match and delete them too.
 */
async function deleteInlineByIds(
  run: GhRunner,
  target: VerifiedTarget,
  ids: number[]
): Promise<void> {
  await Promise.allSettled(
    ids.map((id) =>
      ghApi(run, [
        `repos/${target.repo}/pulls/comments/${id}`,
        "--method",
        "DELETE",
      ])
    )
  );
}

/**
 * A `Poster` backed by the `gh` CLI, driven through the injected `run`. `selfLogin` (from `SQUAREWRIGHT_BOT_LOGIN`,
 * declared in the workflow templates — `github-actions[bot]` by default) scopes sticky/inline edit+delete to OUR
 * OWN comments (issue #157). Omitted → marker-only matching, exactly today's behavior (fail-safe).
 */
export function createGhPoster(
  run: GhRunner,
  opts: { selfLogin?: string } = {}
): Poster {
  const { selfLogin } = opts;
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
      // Replace, never accumulate — but POST the new review BEFORE deleting the old comments, so a failure never
      // leaves the PR with zero of our comments (worse than stale ones). We capture the prior ids first (the new
      // comments carry the same marker, so we couldn't tell them apart afterward), post, then best-effort delete
      // the captured old ids. Order: capture → post → delete. A post failure leaves the old set intact (stale but
      // present); a delete failure leaves a duplicate (recoverable) — neither is data loss.
      const priorIds = await priorInlineIds(run, target, selfLogin);
      if (inline.length > 0) {
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
      }
      await deleteInlineByIds(run, target, priorIds);
    },
    upsertSticky: async (target, body) => {
      const payload = JSON.stringify({ body });
      const existing = await findStickyId(run, target, selfLogin);
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
 *
 * The `commits/{sha}/pulls` endpoint returns PRs that have this commit ANYWHERE in their ref history, not only where
 * it is the current head — so we filter to `head.sha === sha`. Without that, STACKED PRs (PR-B branched off PR-A)
 * share history and both come back, tripping the trust check's `>1 open PR ⇒ TrustViolation` ambiguity guard and
 * FALSELY refusing to post an otherwise-valid review. Filtering to the real head also makes a force-pushed PR (its
 * head moved off the reviewed `sha`) resolve to zero → the benign no-op, which is correct: the reviewed commit is
 * stale, so there is nothing to post to. `sha` is the trusted `workflow_run.head_sha`, never an artifact claim.
 */
export function createGhPullLookup(run: GhRunner): LookupPullsForCommit {
  return async (repo, sha) => {
    const endpoint = `repos/${repo}/commits/${sha}/pulls`;
    const stdout = await ghApi(run, [endpoint, "--paginate"]);
    const pulls = parseJson<
      { head?: { sha?: string }; number: number; state: string }[]
    >(stdout, endpoint);
    return pulls
      .filter((p) => p.state === "open" && p.head?.sha === sha)
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
