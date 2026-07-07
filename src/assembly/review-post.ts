/**
 * Orchestrate a `review --phase post` run. Preflight EVERY required provider key — the config's lanes plus the
 * openrouter structurer (src/pi/worker.ts) — before any model call, so a run can't spend on pass 1 and then
 * fail on pass 2's missing key. Worker construction is injected so the flow is testable without a real Pi
 * session (and so the preflight provably runs before the worker exists).
 */
import type { ReviewContext } from "../core/types.js";
import { envApiKeys, missingApiKeys } from "../pi/keys.js";
import type { PiWorker } from "../pi/session.js";
import type { AssemblyConfig } from "./config.js";
import { type ReviewOutput, runReview } from "./review.js";

/** Providers whose keys the review needs: the config's lanes plus the openrouter structurer. */
export function requiredProviders(config: AssemblyConfig): Set<string> {
  const providers = new Set(config.lanes.map((l) => l.provider));
  providers.add("openrouter");
  return providers;
}

export async function runReviewPost(
  config: AssemblyConfig,
  context: ReviewContext,
  makeWorker: (apiKeys: Record<string, string>) => PiWorker
): Promise<ReviewOutput> {
  const providers = requiredProviders(config);
  const missing = missingApiKeys(providers);
  if (missing.length > 0) {
    throw new Error(
      `Missing required provider key(s): ${missing.join(", ")}. ` +
        "Set them before running review — no model runs until every required key is present."
    );
  }
  return await runReview(context, config, makeWorker(envApiKeys(providers)));
}
