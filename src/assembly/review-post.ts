/**
 * Orchestrate a `review --phase post` run. Preflight EVERY required provider key — the config's lanes plus the
 * openrouter structurer (src/pi/worker.ts) — before any model call, so a run can't spend on pass 1 and then
 * fail on pass 2's missing key. Key resolution and worker construction are injected so the flow is testable
 * without Pi (and so the preflight provably precedes the worker).
 */
import type { ReviewContext } from "../core/types.js";
import type { ResolvedKeys } from "../pi/keys.js";
import type { PiWorker } from "../pi/session.js";
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
