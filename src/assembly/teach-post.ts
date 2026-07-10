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
  const findingText = deps.fetchFinding
    ? await deps.fetchFinding(env)
    : env.TEACH_FINDING;

  const outcome = await handleTeachReply({
    authorized,
    findingText,
    interpreter: deps.interpreter,
    replyText,
  });

  if (outcome.kind === "post") {
    const target: TeachTarget = { issueNumber, repo };
    await deps.poster.postComment(
      { prNumber: issueNumber, repo },
      outcome.body
    );
    return { outcome, posted: target };
  }
  return { outcome };
}
