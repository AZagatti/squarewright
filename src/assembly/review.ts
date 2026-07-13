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
import { selectPersonasWithDrops } from "../personas/routing.js";
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

/**
 * Cost-visibility threshold (in the spirit of the money-guard, though not the paid-spend hard rule itself): the
 * trusted `.review-rules` + `contextDocs` preamble is re-injected into EVERY persona pass, so its size is paid once
 * per pass. Above this we WARN (never truncate — it's trusted maintainer-authored content; silently cutting a rule
 * could invert its meaning) so a maintainer whose docs/rules grew large notices the per-review cost. Heuristic:
 * being off by some chars only shifts when the harmless warning fires. ~24k chars ≈ 6k tokens, well above a normal
 * curated rules+docs set.
 */
const LARGE_PREAMBLE_CHARS = 24_000;

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
 * Run the opt-in AC-conformance auditor as its OWN pass — iff the config has an `acCheck` persona AND the PR closes
 * a fetched issue (`context.linkedIssue`). Kept a separate Worker call (with `acCheck` on, which injects the
 * UNTRUSTED issue text into the user turn only) so that text never enters the defect personas' context — the
 * measured intent-confound. Returns the pass result + resolved lens, or `null` when it doesn't apply (no AC persona,
 * or a PR that links nothing) so production is unaffected until a repo adds the persona.
 */
async function runAcPass(
  personas: AssemblyConfig["personas"],
  config: AssemblyConfig,
  context: ReviewContext,
  worker: PiWorker
): Promise<{
  errored: boolean;
  findings: Finding[];
  incomplete: boolean;
  lens: { id: string; label: string };
  model: string;
  summary?: string;
} | null> {
  const acPersona = personas.find((p) => p.acCheck);
  if (!(acPersona && context.linkedIssue)) {
    return null;
  }
  const base = config.lanes.find((l) => l.id === acPersona.lane);
  if (!base) {
    // Deterministic config error (undefined lane) — fail loud, never swallowed as a transient (mirrors laneForPass).
    const known = config.lanes.map((l) => l.id).join(", ");
    throw new Error(
      `AC persona "${acPersona.id}" references lane "${acPersona.lane}", which is not defined. Known lanes: [${known}].`
    );
  }
  const lane: ModelLane = {
    ...base,
    thinking: acPersona.thinking ?? base.thinking,
  };
  const lens = { id: acPersona.id, label: acPersona.label ?? acPersona.id };
  try {
    const result = await worker.run({
      acCheck: true,
      budget: config.budget,
      context,
      lane,
      persona: acPersona.id,
      // no rules preamble / rule-drift: the AC pass checks the linked issue's criteria, not project rules.
      systemPrompt: acPersona.prompt,
    });
    return {
      // a failed pass-1 analysis (refusal / non-retryable quota) is a run failure, not a clean AC check
      errored: result.usage?.analysisFailed ?? false,
      findings: result.findings,
      incomplete: result.usage?.submitted === false,
      lens,
      model: lane.model,
      summary: result.usage?.summary?.trim() || undefined,
    };
  } catch (e) {
    // Isolate an AC model-run error like the persona loop's: don't let it drop the main passes' findings.
    console.error(
      `AC-conformance pass failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return {
      errored: true,
      findings: [],
      incomplete: false,
      lens,
      model: lane.model,
    };
  }
}

/** Accumulated results of running every persona pass — merged with the AC pass in `runReview`. */
interface PersonaPassResults {
  /** passes that threw mid-run (isolated per-pass); disclosed in the sticky, never silently swallowed */
  erroredPassIds: Set<string>;
  findings: Finding[];
  /** passes whose structurer never submitted (`usage.submitted === false`) — ran but failed */
  incompletePassIds: Set<string>;
  modelsUsed: Set<string>;
  summaries: string[];
}

/**
 * Run every persona pass sequentially, ISOLATING each so one lens's mid-run error (e.g. a provider outage that
 * outlived Pi's retries) can't drop the others' real findings. A config error from `laneForPass` (unresolvable
 * lane) is a deterministic misconfig and stays UNCAUGHT — we isolate model-run errors, not setup bugs. Errored and
 * structurer-didn't-submit passes are recorded (not silently dropped) for the sticky's honesty disclosures.
 */
async function runPersonaPasses(
  passes: ReviewPass[],
  personas: AssemblyConfig["personas"],
  config: AssemblyConfig,
  context: ReviewContext,
  worker: PiWorker,
  preamble: string
): Promise<PersonaPassResults> {
  const findings: Finding[] = [];
  const summaries: string[] = [];
  const modelsUsed = new Set<string>();
  const incompletePassIds = new Set<string>();
  const erroredPassIds = new Set<string>();
  for (const pass of passes) {
    const lane: ModelLane = {
      ...laneForPass(pass, personas, config),
      thinking: pass.thinking,
    };
    modelsUsed.add(lane.model);
    let result: Awaited<ReturnType<PiWorker["run"]>>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: passes run sequentially by design — bounded (≤MAX_PERSONAS) and keeps provider concurrency low
      result = await worker.run({
        // budget flows to the worker so a future enforcer can honor it; today it's ADVISORY — the worker doesn't
        // read it, because a hard mid-run tool-call/token cap needs an abort primitive Pi doesn't expose.
        budget: config.budget,
        context,
        // Prompted CoT scaffold (precision lever) — off unless the repo opts in via `.squarewright.yml`.
        cotScaffold: config.cotScaffold,
        lane,
        persona: pass.id,
        // Rule-drift proposals (ADR-0005 §2) only when the repo has adopted the rules/docs system — a non-empty
        // preamble means Tier-A rules and/or Tier-B docs were loaded, so "propose a rule the loaded set misses" is
        // meaningful. Repos that opted out never see drift-noise.
        proposeRuleDrift: preamble.length > 0,
        systemPrompt: preamble + pass.prompt,
      });
    } catch (e) {
      // A per-pass failure must not abort the whole review — record it for an honest sticky disclosure and log the
      // cause for CI, then continue with the remaining lenses (whose findings would otherwise be lost).
      erroredPassIds.add(pass.id);
      console.error(
        `Review pass "${pass.id}" failed: ${e instanceof Error ? e.message : String(e)}`
      );
      continue;
    }
    findings.push(...result.findings);
    // Pass-1 analysis failed (provider refusal / non-retryable quota error) — the empty findings are a FAILURE,
    // not a clean review, and it didn't throw, so disclose it as errored (a provider failure) rather than let it
    // ship as "nothing found". Checked before `submitted` because on this path `submitted` is a misleading true.
    if (result.usage?.analysisFailed) {
      erroredPassIds.add(pass.id);
    } else if (result.usage && result.usage.submitted === false) {
      // A defined-and-false `submitted` means the structurer never submitted for this pass (undefined = no signal,
      // e.g. a stub without usage — don't warn on that). Never treat a failed submission as a clean pass.
      incompletePassIds.add(pass.id);
    }
    if (result.usage?.summary?.trim()) {
      summaries.push(result.usage.summary.trim());
    }
  }
  return { erroredPassIds, findings, incompletePassIds, modelsUsed, summaries };
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
  // `dropped` = personas that matched the change-set but were cut by the cap. Surfaced in the sticky (never
  // silent) so a capped review doesn't imply coverage it skipped — see the honesty note on `renderSticky`.
  const { selected, dropped } = selectPersonasWithDrops(
    personas,
    context.files,
    {
      cap: MAX_PERSONAS,
    }
  );
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
    if (preamble.length > LARGE_PREAMBLE_CHARS) {
      console.warn(
        `⚠️  Project review context (.review-rules + contextDocs) is ${preamble.length} chars and is injected into ` +
          `each of ${passes.length} review pass(es) (~${preamble.length * passes.length} chars of prompt overhead ` +
          "this review). Trim the rules/docs or scope their globs more tightly to cut per-review cost."
      );
    }
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

  const {
    findings: all,
    summaries,
    modelsUsed,
    incompletePassIds,
    erroredPassIds,
  } = await runPersonaPasses(
    passes,
    personas,
    config,
    context,
    worker,
    preamble
  );

  const ac = await runAcPass(personas, config, context, worker);
  if (ac) {
    modelsUsed.add(ac.model);
    lenses.push(ac.lens); // attribute AC findings + list it in the honesty footer roster
    if (ac.errored) {
      erroredPassIds.add(ac.lens.id);
    } else {
      all.push(...ac.findings);
      if (ac.incomplete) {
        incompletePassIds.add(ac.lens.id);
      }
      if (ac.summary) {
        summaries.push(ac.summary);
      }
    }
  }

  // crossSourceOnly: on the production path each persona runs exactly one pass, so only genuine cross-persona
  // agreement should collapse — never two distinct findings from the same pass (that drops one). The eval's
  // --samples path deliberately leaves this off so re-sampled duplicates of one persona still union.
  const findings = aggregateFindings(all, { crossSourceOnly: true });
  const { inline, unplaceable } = mapToInlineComments(findings, context.files, {
    labelFor,
  });
  const sticky = renderSticky({
    // matched-but-capped personas: disclose so a truncated review doesn't imply full coverage.
    droppedLenses: dropped.map((p) => ({ id: p.id, label: p.label ?? p.id })),
    // passes that threw mid-run: disclose so a lens lost to a transient error doesn't read as "nothing found".
    erroredLenses: lenses.filter((l) => erroredPassIds.has(l.id)),
    findings,
    // passes whose structurer failed to submit: disclose so a failed lens doesn't read as "nothing found".
    incompleteLenses: lenses.filter((l) => incompletePassIds.has(l.id)),
    lenses,
    model: modelsUsed.size > 0 ? [...modelsUsed].join(", ") : undefined,
    summary: summaries.join("\n\n"),
  });
  return { findings, inline, sticky, unplaceable };
}
