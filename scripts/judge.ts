/**
 * Offline defect-match judge: re-scores a saved eval report against ground truth using an LLM judge, so we
 * see real DEFECT recall (did a finding describe the actual bug?) vs the loose FILE recall the eval prints.
 * Reuses saved findings — no worker re-run. Default judge = free z.ai glm-5.2.
 *
 * The judge is itself stochastic, so `--judge-repeats K` re-scores the whole report K times and reports the
 * defect-recall as a min–median–max spread — a single judged pass is not a number. Pass `--reports p1,p2,…`
 * (≥1 reports of the SAME config) instead of `--report` to get the analysis×judge matrix: a recall interval
 * that separates analysis variance (across reports) from judge variance (within a report).
 *
 *   bun run scripts/judge.ts --report eval/reports/<file>.json [--model zai:glm-5.2] [--judge-repeats 3]
 *   bun run scripts/judge.ts --reports "eval/reports/a.json,eval/reports/b.json" --judge-repeats 3
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelLane } from "../src/core/types.js";
import {
  createJudge,
  type DefectLocus,
  type JudgedFinding,
  summarize,
  summarizeMatrix,
  ungradedWarning,
} from "../src/eval/judge.js";
import {
  makeSpendGuard,
  openrouterPrice,
  parseMaxSpend,
  type SpendGuard,
  type TokenPrice,
} from "../src/safety/spend-guard.js";

const ROOT = new URL("..", import.meta.url).pathname;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function readKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  try {
    keys.openrouter = readFileSync(`${homedir()}/.or_key`, "utf8").trim();
  } catch {
    /* */
  }
  try {
    keys.zai = readFileSync(`${homedir()}/.zai_key`, "utf8").trim();
  } catch {
    /* */
  }
  return keys;
}

interface Case {
  expect_loci?: DefectLocus[];
  id: string;
  label: string;
}
interface ReportResult {
  findings?: JudgedFinding[];
  hitLoci?: number;
  id: string;
}
interface ScoredCase {
  c: Case & { expect_loci: DefectLocus[] };
  r: ReportResult;
}
type Judge = ReturnType<typeof createJudge>;

/** Parse `provider:model` (default free z.ai glm-5.2), splitting on the first colon so OpenRouter's
 *  `provider:vendor/name:free` ids survive intact. thinking-off so the judge never drops the tool call. */
function buildLane(judgeArg: string): ModelLane {
  return {
    id: "judge",
    model: judgeArg.slice(judgeArg.indexOf(":") + 1),
    provider: judgeArg.slice(0, judgeArg.indexOf(":")),
    thinking: "off",
  };
}

/** Positive-integer `--judge-repeats` (default 1); rejects non-numeric/zero so a typo can't silently no-op. */
function parseRepeats(): number {
  const raw = arg("judge-repeats");
  const n = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `--judge-repeats must be a positive integer (got "${raw}")`
    );
  }
  return n;
}

/** The scorable has-issue cases (clean cases carry no defect loci to judge). */
function selectScored(
  results: ReportResult[],
  byId: Map<string, Case>
): ScoredCase[] {
  return results
    .map((r) => ({ c: byId.get(r.id), r }))
    .filter(
      (x): x is ScoredCase =>
        x.c?.label === "has-issue" && !!x.c.expect_loci?.length
    );
}

/**
 * Re-score the report `repeats` times. Money is guarded (AGENTS.md §4): re-scoring K× over N cases against a
 * PAID judge is a loop that must not run uncapped, so each call's token-estimate feeds `guard` and the run
 * aborts the moment it exceeds the cap. A pass cut short is dropped (not recorded as a truncated data point).
 */
async function runPasses(
  judge: Judge,
  lane: ModelLane,
  scored: ScoredCase[],
  ctx: { guard: SpendGuard; price: TokenPrice; repeats: number; total: number }
): Promise<{
  calls: number;
  perCase: Map<string, number[]>;
  perPassRecall: number[];
  ungraded: number;
}> {
  const perCase = new Map<string, number[]>();
  const perPassRecall: number[] = [];
  let ungraded = 0;
  let calls = 0;
  let aborted = false;
  for (let k = 0; k < ctx.repeats && !aborted; k += 1) {
    let passTotal = 0;
    for (const { r, c } of scored) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design — respects the judge model's concurrency limits AND lets the spend guard see each call's cost before the next fires
      const { grades, usage, graded } = await judge.judge(
        c.expect_loci,
        r.findings ?? [],
        lane
      );
      calls += 1;
      if (!graded) {
        ungraded += 1;
      }
      ctx.guard.add(usage.input * ctx.price.in + usage.output * ctx.price.out);
      const matched = grades.filter((g) => g.matched).length;
      passTotal += matched;
      perCase.set(r.id, [...(perCase.get(r.id) ?? []), matched]);
      if (ctx.guard.tripped()) {
        console.log(
          `\n🛑 SPEND CAP: judge run spent ~$${ctx.guard.spent().toFixed(4)} (> cap). Aborting; partial results below.`
        );
        aborted = true;
        break;
      }
    }
    if (!aborted) {
      perPassRecall.push(passTotal);
      if (ctx.repeats > 1) {
        console.log(
          `  pass ${k + 1}/${ctx.repeats}: defect ${passTotal}/${ctx.total}`
        );
      }
    }
  }
  return { calls, perCase, perPassRecall, ungraded };
}

function printReport(
  scored: ScoredCase[],
  perCase: Map<string, number[]>,
  perPassRecall: number[],
  ctx: { fileHits: number; total: number; repeats: number }
): void {
  console.log("\n── per case (defect matches across passes) ──");
  for (const { r, c } of scored) {
    const passes = perCase.get(r.id);
    const n = c.expect_loci.length;
    if (!passes?.length) {
      // Reached only when a spend-cap abort skipped this case — show it as un-judged, not as a 0.
      console.log(
        `  ${r.id.padEnd(28)} file=${r.hitLoci ?? 0}/${n}  defect=—/${n} (not judged)`
      );
      continue;
    }
    const s = summarize(passes);
    const range = s.min === s.max ? `${s.min}` : `${s.min}–${s.max}`;
    console.log(
      `  ${r.id.padEnd(28)} file=${r.hitLoci ?? 0}/${n}  defect=${range}/${n}`
    );
  }

  console.log("\n── recall ──");
  console.log(`  FILE-level (eval metric): ${ctx.fileHits}/${ctx.total}`);
  if (perPassRecall.length === 0) {
    console.log(
      "  DEFECT-level (judge):     no complete pass — spend cap hit mid-first-pass (see per-case above)"
    );
    return;
  }
  const overall = summarize(perPassRecall);
  if (ctx.repeats === 1) {
    console.log(`  DEFECT-level (judge):     ${overall.median}/${ctx.total}`);
  } else {
    console.log(
      `  DEFECT-level (judge, ${perPassRecall.length}/${ctx.repeats} complete passes): ${overall.min}–${overall.max}/${ctx.total} (median ${overall.median})`
    );
    console.log(`  per-pass totals: [${perPassRecall.join(", ")}]`);
  }
  console.log(
    `  → the file metric over-credited the median by ${ctx.fileHits - overall.median} loci`
  );
}

interface JudgeCtx {
  byId: Map<string, Case>;
  guard: SpendGuard;
  judge: Judge;
  lane: ModelLane;
  maxSpend: number;
  paid: boolean;
  price: TokenPrice;
  repeats: number;
}

/** Score one report (K judge-passes) and print its per-case + spread report. */
async function runSingle(reportPath: string, ctx: JudgeCtx): Promise<void> {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    results: ReportResult[];
    config?: unknown;
  };
  const scored = selectScored(report.results, ctx.byId);
  const total = scored.reduce((n, { c }) => n + c.expect_loci.length, 0);
  const fileHits = scored.reduce((n, { r }) => n + (r.hitLoci ?? 0), 0);

  console.log(`\n▸ judging ${reportPath}`);
  console.log(`  config: ${JSON.stringify(report.config ?? "(none)")}`);
  console.log(`  judge:  ${ctx.lane.provider}/${ctx.lane.model}`);
  console.log(
    `  passes: ${ctx.repeats}${ctx.paid ? `  (PAID judge — spend cap $${ctx.maxSpend})` : ""}\n`
  );

  const { perCase, perPassRecall, ungraded, calls } = await runPasses(
    ctx.judge,
    ctx.lane,
    scored,
    {
      guard: ctx.guard,
      price: ctx.price,
      repeats: ctx.repeats,
      total,
    }
  );
  printReport(scored, perCase, perPassRecall, {
    fileHits,
    repeats: ctx.repeats,
    total,
  });
  const warn = ungradedWarning(ungraded, calls);
  if (warn) {
    console.log(`\n${warn}`);
  }
  if (ctx.paid) {
    console.log(
      `  judge spend (token estimate): ~$${ctx.guard.spent().toFixed(4)} of $${ctx.maxSpend} cap`
    );
  }
  console.log("");
}

function band(s: { max: number; median: number; min: number }): string {
  return s.min === s.max
    ? `${s.min}`
    : `${s.min}–${s.max} (median ${s.median})`;
}

/**
 * Matrix mode: score ≥1 reports of the SAME config (typically from `eval --repeat N`), each K judge-passes, and
 * report the config's defect-recall as an interval that separates analysis variance (spread across reports)
 * from judge variance (spread within a fixed report) — so recall is a range, not a point (#49 AC3). One shared
 * spend guard caps the whole matrix.
 */
async function runMatrix(reportPaths: string[], ctx: JudgeCtx): Promise<void> {
  console.log(
    `\n▸ matrix: ${reportPaths.length} report(s) × ${ctx.repeats} judge-pass(es)`
  );
  console.log(
    `  judge:  ${ctx.lane.provider}/${ctx.lane.model}${ctx.paid ? `  (PAID — spend cap $${ctx.maxSpend})` : ""}\n`
  );

  const configs = new Set<string>();
  const totals = new Set<number>();
  const matrix: number[][] = [];
  let excluded = 0;
  let stoppedEarly = false;
  let ungraded = 0;
  let calls = 0;
  for (const p of reportPaths) {
    // Money is guarded across the WHOLE matrix: once the cap trips, don't start another report's passes.
    if (ctx.guard.tripped()) {
      stoppedEarly = true;
      break;
    }
    const report = JSON.parse(readFileSync(p, "utf8")) as {
      results: ReportResult[];
      config?: unknown;
    };
    configs.add(JSON.stringify(report.config ?? null));
    const scored = selectScored(report.results, ctx.byId);
    const total = scored.reduce((n, { c }) => n + c.expect_loci.length, 0);
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design — the shared spend guard must see each report's cost before the next report's passes fire
    const pass = await runPasses(ctx.judge, ctx.lane, scored, {
      guard: ctx.guard,
      price: ctx.price,
      repeats: ctx.repeats,
      total,
    });
    const { perPassRecall } = pass;
    ungraded += pass.ungraded;
    calls += pass.calls;
    if (perPassRecall.length === 0) {
      // No complete pass (spend cap cut this report short) — exclude it, never fold a fake 0 into the
      // interval, and keep its loci total out of the denominator too.
      excluded += 1;
      console.log(`  ${basename(p).padEnd(46)} (no complete pass — excluded)`);
      continue;
    }
    totals.add(total);
    matrix.push(perPassRecall);
    console.log(
      `  ${basename(p).padEnd(46)} [${perPassRecall.join(", ")}]/${total}`
    );
  }

  if (configs.size > 1) {
    console.log(
      `\n⚠️  reports span ${configs.size} different configs — the interval below mixes setups, not one config's recall.`
    );
  }
  if (excluded > 0 || stoppedEarly) {
    const why = [
      excluded > 0 ? `${excluded} report(s) had no complete judge pass` : "",
      stoppedEarly
        ? "remaining report(s) skipped after the spend cap tripped"
        : "",
    ].filter(Boolean);
    console.log(
      `\n⚠️  ${why.join("; ")} — interval reflects only the ${matrix.length} report(s) actually judged.`
    );
  }
  // Print the tool-call-failure warning BEFORE the early return, so an all-empty matrix caused by a broken
  // judge (not just cost) still says why.
  const warn = ungradedWarning(ungraded, calls);
  if (warn) {
    console.log(`\n${warn}`);
  }
  if (matrix.length === 0) {
    console.log(
      "\n── no report produced a complete judge pass — nothing to report ──\n"
    );
    return;
  }

  const total = Math.max(...totals);
  if (totals.size > 1) {
    console.log(
      `\n⚠️  reports have different loci totals ${JSON.stringify([...totals])} — denominator shown is the max.`
    );
  }
  const m = summarizeMatrix(matrix);
  console.log("\n── recall interval (defect-level) ──");
  console.log(`  overall (analysis × judge): ${band(m.overall)} / ${total}`);
  console.log(`  analysis variance (per-report medians): ${band(m.analysis)}`);
  console.log(`  judge variance (within-report range):   ${band(m.judge)}`);
  if (ctx.paid) {
    console.log(
      `  judge spend (token estimate): ~$${ctx.guard.spent().toFixed(4)} of $${ctx.maxSpend} cap`
    );
  }
  console.log("");
}

async function main() {
  // --manifest <path> must match the corpus the reports were produced on (default golden), so the case→loci map
  // covers the report's case ids; a mismatched manifest scores every case /0 (its ids aren't found).
  const manifestPath = arg("manifest") ?? `${ROOT}eval/golden/manifest.yaml`;
  const manifest = (
    parseYaml(readFileSync(manifestPath, "utf8")) as {
      cases: Case[];
    }
  ).cases;
  const lane = buildLane(arg("model") ?? "zai:glm-5.2");
  // GLM judges via z.ai are free (price {0,0} → guard never trips). Only a paid cross-family judge
  // (openrouter) accumulates real spend against --max-spend (default $0.25).
  const price =
    lane.provider === "openrouter"
      ? openrouterPrice(lane.model)
      : { in: 0, out: 0 };
  const maxSpend = parseMaxSpend(arg("max-spend"), 0.25);
  const ctx: JudgeCtx = {
    byId: new Map(manifest.map((c) => [c.id, c])),
    guard: makeSpendGuard(maxSpend),
    judge: createJudge({ apiKeys: readKeys() }),
    lane,
    maxSpend,
    paid: price.in > 0 || price.out > 0,
    price,
    repeats: parseRepeats(),
  };

  const reportsArg = arg("reports");
  if (reportsArg !== undefined) {
    const paths = reportsArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      throw new Error("--reports needs a comma-separated list of report paths");
    }
    await runMatrix(paths, ctx);
    return;
  }
  const reportPath = arg("report");
  if (!reportPath) {
    throw new Error(
      "provide --report <path> (or --reports <p1,p2,…> for the analysis×judge matrix)"
    );
  }
  await runSingle(reportPath, ctx);
}

main().catch((e) => {
  console.error("judge failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
