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
import type { PiWorker, RepoReader } from "../pi/session.js";
import { loadContextDocs, renderContextDocs } from "../rules/context-docs.js";
import {
  loadReviewRules,
  renderReviewRules,
  selectReviewRules,
} from "../rules/review-rules.js";
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

/**
 * Compose an Assembly over a PR into review output. No network — inject a `PiWorker`.
 *
 * When `opts.repoReader` is supplied, project context relevant to the changed files is prepended to every pass
 * prompt (ADR-0005 §1): Tier-A `.review-rules/*.md` as trusted, precedence-taking rules, then Tier-B
 * `config.contextDocs` (existing docs like `AGENTS.md`) as background context. The reader MUST be bound to the
 * trusted **base** revision — see the trust note in `src/rules/review-rules.ts`. With no reader, behavior is
 * unchanged. The reader is used for context loading only; it is never forwarded to the Worker (grounding stays off).
 */
export async function runReview(
  context: ReviewContext,
  config: AssemblyConfig,
  worker: PiWorker,
  opts: { repoReader?: RepoReader } = {}
): Promise<ReviewOutput> {
  const { personas } = config;
  const selected = selectPersonas(personas, context.files, {
    cap: MAX_PERSONAS,
  });
  const passes = buildPasses(selected);

  // Load project context to prepend to every pass, only when something will run (a docs-only PR selects no
  // personas → no prompt to inject into, so the reads would be pure waste). Tier-A `.review-rules` (precedence)
  // first, then Tier-B `contextDocs` (background) — both from the trusted base checkout via `opts.repoReader`.
  let preamble = "";
  if (opts.repoReader && passes.length > 0) {
    const changedPaths = context.files.map((f) => f.path);
    const rules = renderReviewRules(
      selectReviewRules(await loadReviewRules(opts.repoReader), changedPaths)
    );
    const docs = renderContextDocs(
      await loadContextDocs(
        opts.repoReader,
        config.contextDocs ?? [],
        changedPaths
      )
    );
    preamble = rules + docs;
  }

  // A finding's `source` is its PASS id; attribute it to the pass's persona label(s) for the review output.
  const lensLabel = (id: string) =>
    selected.find((p) => p.id === id)?.label ?? id;
  const lenses = passes.map((pass) => ({
    id: pass.id,
    label: [...new Set(pass.personaIds.map(lensLabel))].join(", "),
  }));
  const labelFor = (source: string) =>
    lenses.find((l) => l.id === source)?.label ?? source;

  const all: Finding[] = [];
  const summaries: string[] = [];
  const modelsUsed = new Set<string>();
  for (const pass of passes) {
    const lane: ModelLane = {
      ...laneForPass(pass, personas, config),
      thinking: pass.thinking,
    };
    modelsUsed.add(lane.model);
    // biome-ignore lint/performance/noAwaitInLoops: passes run sequentially by design — bounded (≤MAX_PERSONAS) and keeps provider concurrency low
    const result = await worker.run({
      // budget flows to the worker so a future enforcer can honor it; today it's ADVISORY — the worker doesn't
      // read it, because a hard mid-run tool-call/token cap needs an abort primitive Pi doesn't expose.
      budget: config.budget,
      context,
      lane,
      persona: pass.id,
      systemPrompt: preamble + pass.prompt,
    });
    all.push(...result.findings);
    if (result.usage?.summary?.trim()) {
      summaries.push(result.usage.summary.trim());
    }
  }

  const findings = aggregateFindings(all);
  const { inline, unplaceable } = mapToInlineComments(findings, context.files, {
    labelFor,
  });
  const sticky = renderSticky({
    findings,
    lenses,
    model: modelsUsed.size > 0 ? [...modelsUsed].join(", ") : undefined,
    summary: summaries.join("\n\n"),
  });
  return { findings, inline, sticky, unplaceable };
}
