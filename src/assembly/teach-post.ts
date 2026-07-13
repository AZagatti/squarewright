/**
 * The `teach` command orchestration (ADR-0005 §3 Part B): read the trusted teach-workflow env, decide whether the
 * actor may teach, interpret the reply into a candidate rule, and post the suggestion — all effects injected, so
 * the control flow is unit-testable without a live model or GitHub (mirrors `runReviewCommand`).
 *
 * Trust: every env field here is set by the Teach workflow from the `issue_comment`/`pull_request_review_comment`
 * event, which GitHub runs from the base repo's DEFAULT branch with server-computed fields — so the repo, issue
 * number, actor, association, and permission are trusted (no artifact cross-check needed; see `trust.ts`). The
 * reply body is the one UNTRUSTED field and is handled as data downstream (`handleTeachReply` → interpreter).
 * Authorization is checked before the model is ever called (`handleTeachReply` short-circuits on `authorized`).
 */
import type { Poster } from "../github/poster.js";
import {
  handleTeachReply,
  type ReplyInterpreter,
  type TeachOutcome,
} from "../rules/teach-reply.js";
import { isAuthorizedTeachActor, type TeachTarget } from "../safety/trust.js";

export interface TeachCommandDeps {
  env: NodeJS.ProcessEnv;
  /**
   * Fetch the finding text a `pull_request_review_comment` reply is attached to (via `in_reply_to_id`), for
   * grounding. Optional; when absent the `TEACH_FINDING` env value (if any) is used. Injected so it's stubbable.
   */
  fetchFinding?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  interpreter: ReplyInterpreter;
  poster: Poster;
}

export interface TeachCommandResult {
  outcome: TeachOutcome;
  /** the target actually posted to, present only when a suggestion was posted */
  posted?: TeachTarget;
}

/**
 * Stable per-reply dedupe marker, embedded invisibly at the top of a teach suggestion so a workflow RE-RUN (a
 * redelivery, a manual re-run of the same `issue_comment` event) detects its own prior post and skips instead of
 * double-suggesting (#159). `TEACH_COMMENT_ID` is the triggering comment's GitHub id — a trusted event field,
 * exactly one teach fire per comment, so it's a stable idempotency key. Absent id → no marker → today's
 * always-post behavior (fail-safe: a hand-rolled workflow that doesn't export it keeps working, just without
 * dedup). The HTML-comment form renders invisibly on GitHub and sits at position 0 so `isOurComment`'s
 * `startsWith` match finds it.
 */
function teachDedupeMarker(commentId: string | undefined): string | undefined {
  const id = commentId?.trim();
  return id ? `<!-- squarewright:teach:${id} -->` : undefined;
}

/** Fail closed: a required trusted signal is missing, so refuse rather than guess a target. */
function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) {
    throw new Error(
      `teach requires ${key} in the environment (exported by the Squarewright Teach workflow). Refusing to run without it.`
    );
  }
  return v;
}

export async function runTeachCommand(
  deps: TeachCommandDeps
): Promise<TeachCommandResult> {
  const { env } = deps;
  const repo = requireEnv(env, "TEACH_REPO");
  const issueNumber = Number.parseInt(requireEnv(env, "TEACH_ISSUE"), 10);
  if (Number.isNaN(issueNumber)) {
    throw new Error(
      `teach: TEACH_ISSUE is not a number ("${env.TEACH_ISSUE}").`
    );
  }
  const replyText = requireEnv(env, "TEACH_BODY");

  const authorized = isAuthorizedTeachActor({
    actorLogin: env.TEACH_ACTOR ?? "",
    association: env.TEACH_ASSOCIATION ?? "",
    permission: env.TEACH_PERMISSION ?? "",
    prAuthorLogin: env.TEACH_PR_AUTHOR ?? "",
  });
  // Fetch the grounding finding only for an authorized actor — an unauthorized reply short-circuits below, so a
  // fetch here would be wasted work (and shouldn't touch the API on their behalf at all).
  let findingText: string | undefined;
  if (authorized) {
    findingText = deps.fetchFinding
      ? await deps.fetchFinding(env)
      : env.TEACH_FINDING;
  }

  const outcome = await handleTeachReply({
    authorized,
    findingText,
    interpreter: deps.interpreter,
    replyText,
  });

  if (outcome.kind === "post") {
    const target: TeachTarget = { issueNumber, repo };
    // Idempotency (#159): a workflow re-run for the same reply must not double-suggest. When we can key off the
    // triggering comment id, skip if we've already posted for it; otherwise embed the marker so a future run can.
    const dedupeMarker = teachDedupeMarker(env.TEACH_COMMENT_ID);
    if (
      dedupeMarker &&
      (await deps.poster.hasOwnComment(
        { prNumber: issueNumber, repo },
        dedupeMarker
      ))
    ) {
      return { outcome: { kind: "skip", reason: "already-posted" } };
    }
    const body = dedupeMarker
      ? `${dedupeMarker}\n\n${outcome.body}`
      : outcome.body;
    await deps.poster.postComment({ prNumber: issueNumber, repo }, body);
    return { outcome, posted: target };
  }
  return { outcome };
}
