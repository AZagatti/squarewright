/**
 * runReview — the pure Assembly composer (ROADMAP M1). Turns a gathered PR + an Assembly config into
 * rendered review output (sticky summary + inline comments) with **no GitHub API calls**. This is the
 * composition already proven in `scripts/eval.ts`, lifted into product code so `squarewright review` can
 * reach it.
 *
 * Pure and injectable: it takes a `PiWorker`, so it is testable without network or secrets. The CLI wiring
 * (M1 next slice) constructs the real worker via `createPiWorker({ apiKeys })`; tests pass a stub.
 */

import type { Finding, ModelLane, ReviewContext } from "../core/types.js";
import { type InlineComment, mapToInlineComments } from "../github/inline.js";
import {
  type AggregatedFinding,
  aggregateFindings,
} from "../output/aggregate.js";
import { renderSticky } from "../output/render.js";
import { buildPasses, type ReviewPass } from "../personas/defaults.js";
import { selectPersonas } from "../personas/routing.js";
import type { PiWorker } from "../pi/session.js";
import type { AssemblyConfig } from "./config.js";

/** Max review lenses per change-set — keeps cost and attention bounded. */
const MAX_PERSONAS = 4;

export interface ReviewOutput {
  /** the deduplicated findings behind the output (for the feedback/data loop) */
  findings: AggregatedFinding[];
  /** inline PR comments, one per finding that lands on a commentable diff line */
  inline: InlineComment[];
  /** rendered sticky summary (markdown, injection-safe) — ready to post as-is */
  sticky: string;
  /** findings that couldn't be placed on a diff line (they still appear in the sticky) */
  unplaceable: Finding[];
}

/**
 * Resolve the concrete model lane for one pass — **fail fast**, never a silent fallback to a different
 * (possibly more expensive) model. A pass whose personas share one lane uses it; a batched pass whose
 * personas span lanes uses `defaultLane`; anything unresolvable is a config error.
 */
function laneForPass(
  pass: ReviewPass,
  personas: AssemblyConfig["personas"],
  config: AssemblyConfig
): ModelLane {
  const laneById = new Map(config.lanes.map((l) => [l.id, l]));
  const laneIds = [
    ...new Set(
      pass.personaIds.map((id) => personas.find((p) => p.id === id)?.lane)
    ),
  ].filter((id): id is string => Boolean(id));

  let chosen: string | undefined;
  if (laneIds.length === 1) {
    [chosen] = laneIds;
  } else if (config.defaultLane) {
    chosen = config.defaultLane;
  }

  const lane = chosen ? laneById.get(chosen) : undefined;
  if (!lane) {
    const known = config.lanes.map((l) => l.id).join(", ");
    const why =
      laneIds.length > 1
        ? `its personas reference different lanes (${laneIds.join(", ")}) and no defaultLane is set`
        : `lane "${laneIds[0] ?? "(none)"}" is not defined`;
    throw new Error(
      `Review pass "${pass.id}" needs a model lane but ${why}. Known lanes: [${known}]. ` +
        "Fix .squarewright.yml (add the lane, align the personas' lane, or set defaultLane)."
    );
  }
  return lane;
}

/** Compose an Assembly over a PR into review output. No network — inject a `PiWorker`. */
export async function runReview(
  context: ReviewContext,
  config: AssemblyConfig,
  worker: PiWorker
): Promise<ReviewOutput> {
  const { personas } = config;
  const selected = selectPersonas(personas, context.files, {
    cap: MAX_PERSONAS,
  });
  const passes = buildPasses(selected);

  const all: Finding[] = [];
  const summaries: string[] = [];
  for (const pass of passes) {
    const lane: ModelLane = {
      ...laneForPass(pass, personas, config),
      thinking: pass.thinking,
    };
    // biome-ignore lint/performance/noAwaitInLoops: passes run sequentially by design — bounded (≤MAX_PERSONAS) and keeps provider concurrency low
    const result = await worker.run({
      context,
      lane,
      persona: pass.id,
      systemPrompt: pass.prompt,
    });
    all.push(...result.findings);
    if (result.usage?.summary?.trim()) {
      summaries.push(result.usage.summary.trim());
    }
  }

  const findings = aggregateFindings(all);
  const { inline, unplaceable } = mapToInlineComments(findings, context.files);
  const sticky = renderSticky({ findings, summary: summaries.join("\n\n") });
  return { findings, inline, sticky, unplaceable };
}
