/**
 * Orchestrate a `review --phase post` run. Preflight EVERY required provider key — the config's lanes plus the
 * openrouter structurer (src/pi/worker.ts) — before any model call, so a run can't spend on pass 1 and then
 * fail on pass 2's missing key. Key resolution and worker construction are injected so the flow is testable
 * without Pi (and so the preflight provably precedes the worker).
 */
import type { ReviewContext } from "../core/types.js";
import type { Poster } from "../github/poster.js";
import type { ResolvedKeys } from "../pi/keys.js";
import type { PiWorker } from "../pi/session.js";
import type {
  ClaimedTarget,
  TrustedRunSignal,
  VerifiedTarget,
} from "../safety/trust.js";
import type { AssemblyConfig } from "./config.js";
import { type ReviewOutput, runReview } from "./review.js";

interface ReviewPostDeps {
  makeWorker: (apiKeys: Record<string, string>) => PiWorker;
  resolveKeys: (providers: Iterable<string>) => Promise<ResolvedKeys>;
}

/** Providers whose keys the review needs: the config's lanes plus the openrouter structurer. */
function requiredProviders(config: AssemblyConfig): Set<string> {
  const providers = new Set(config.lanes.map((l) => l.provider));
  providers.add("openrouter");
  return providers;
}

export async function runReviewPost(
  config: AssemblyConfig,
  context: ReviewContext,
  deps: ReviewPostDeps
): Promise<ReviewOutput> {
  const { apiKeys, missing } = await deps.resolveKeys(
    requiredProviders(config)
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing credentials for provider(s): ${missing.join(", ")}. Set each provider's API key in the ` +
        "environment (see the provider's docs for its key variable) before running review — " +
        "no model runs until every required key is present."
    );
  }
  return await runReview(context, config, deps.makeWorker(apiKeys));
}

interface PostDeps {
  poster: Poster;
  verifyTarget: (
    claimed: ClaimedTarget,
    trusted: TrustedRunSignal
  ) => Promise<VerifiedTarget>;
}

/**
 * Post a produced review to its PR, gated by the trust check. The inline review goes first: it can 422 on a
 * line GitHub rejects against the pinned commit, and failing there before the sticky is posted keeps a half
 * result from implying success. The sticky summary is upserted second.
 */
export async function postReviewOutput(
  output: ReviewOutput,
  claimed: ClaimedTarget,
  trusted: TrustedRunSignal,
  deps: PostDeps
): Promise<VerifiedTarget> {
  const target = await deps.verifyTarget(claimed, trusted);
  await deps.poster.postReview(target, output.inline);
  await deps.poster.upsertSticky(target, output.sticky);
  return target;
}

/** Read the trusted `workflow_run` signals the Review workflow exports; throw (fail closed) if either is absent. */
export function readTrustedRunSignal(env: NodeJS.ProcessEnv): TrustedRunSignal {
  const headSha = env.EVENT_HEAD_SHA;
  const baseRepo = env.EVENT_REPO;
  if (!(headSha && baseRepo)) {
    throw new Error(
      "--post requires the trusted workflow_run signals EVENT_HEAD_SHA and EVENT_REPO in the environment " +
        "(exported by the Squarewright Review workflow). Refusing to post without them."
    );
  }
  return { baseRepo, headSha };
}
