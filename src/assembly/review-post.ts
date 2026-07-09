/**
 * Orchestrate a `review --phase post` run. Preflight EVERY required provider key — the config's lanes plus the
 * structurer (the config's, else the built-in default) — before any model call, so a run can't spend on pass 1
 * and then fail on pass 2's missing key. Key resolution and worker construction are injected so the flow is
 * testable without Pi (and so the preflight provably precedes the worker).
 */
import type { ModelLane, ReviewContext } from "../core/types.js";
import type { Poster } from "../github/poster.js";
import type { ResolvedKeys } from "../pi/keys.js";
import type { PiWorker, RepoReader } from "../pi/session.js";
import { DEFAULT_STRUCTURER } from "../pi/worker.js";
import type {
  LookupPullsForCommit,
  TrustedRunSignal,
  VerifiedTarget,
} from "../safety/trust.js";
import { verifyPostingTarget } from "../safety/trust.js";
import type { AssemblyConfig } from "./config.js";
import { type ReviewOutput, runReview } from "./review.js";

interface ReviewPostDeps {
  makeWorker: (
    apiKeys: Record<string, string>,
    structurerLane?: ModelLane
  ) => PiWorker;
  /**
   * Read-only access to the TRUSTED base checkout, used ONLY to load Tier-A `.review-rules/*.md` (ADR-0005 §1).
   * It is passed to `runReview` for the rules path — it is NOT forwarded into the Worker (that would enable
   * grounding tools, a separate off-by-default feature). Absent => no rules load; behavior is unchanged.
   */
  repoReader?: RepoReader;
  resolveKeys: (providers: Iterable<string>) => Promise<ResolvedKeys>;
}

/** Providers whose keys the review needs: the config's lanes plus the structurer (config's, else the default). */
export function requiredProviders(config: AssemblyConfig): Set<string> {
  const providers = new Set(config.lanes.map((l) => l.provider));
  providers.add(config.structurer?.provider ?? DEFAULT_STRUCTURER.provider);
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
  return await runReview(
    context,
    config,
    deps.makeWorker(apiKeys, config.structurer),
    { repoReader: deps.repoReader }
  );
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

interface ReviewCommandDeps {
  env: NodeJS.ProcessEnv;
  loadConfig: (cwd: string) => AssemblyConfig;
  lookup: LookupPullsForCommit;
  poster: Poster;
  readArtifact: (dir: string) => ReviewContext;
  /** run the review (spends on the model) — injected so the ordering vs. the trust check is testable */
  review: (
    config: AssemblyConfig,
    context: ReviewContext
  ) => Promise<ReviewOutput>;
}

interface ReviewCommandResult {
  /** the rendered dry-run output to print (present when not posting) */
  json?: string;
  /** the target posted to (present when posting succeeded) */
  posted?: VerifiedTarget;
}

/**
 * Orchestrate the `review --phase post` command. When posting, the trust check runs to completion **before** the
 * model does — the env signals are read and `verifyPostingTarget` (a free `gh` read) resolves the target first,
 * so a run that can't post fails closed *and* fails cheap, never after a paid model call (AGENTS.md hard rule #4).
 * The inline review is posted before the sticky: it can 422 on a line GitHub rejects against the pinned commit,
 * and failing there before the sticky keeps a half result from implying success. Every effect is injected.
 */
export async function runReviewCommand(
  opts: { cwd: string; input: string; post?: boolean },
  deps: ReviewCommandDeps
): Promise<ReviewCommandResult> {
  const config = deps.loadConfig(opts.cwd);
  const context = deps.readArtifact(opts.input);

  let target: VerifiedTarget | undefined;
  if (opts.post) {
    const trusted = readTrustedRunSignal(deps.env);
    target = await verifyPostingTarget(context, trusted, deps.lookup);
  }

  const output = await deps.review(config, context);

  if (target) {
    await deps.poster.postReview(target, output.inline);
    await deps.poster.upsertSticky(target, output.sticky);
    return { posted: target };
  }

  const { sticky, inline, unplaceable } = output;
  return {
    json: `${JSON.stringify({ inline, sticky, unplaceable }, null, 2)}\n`,
  };
}
