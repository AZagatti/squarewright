/**
 * Offline defect-match judge: re-scores a saved eval report against ground truth using an LLM judge, so we
 * see real DEFECT recall (did a finding describe the actual bug?) vs the loose FILE recall the eval prints.
 * Reuses saved findings — no worker re-run. Default judge = free z.ai glm-5.2.
 *
 * The judge is itself stochastic, so `--judge-repeats K` re-scores the whole report K times and reports the
 * defect-recall as a min–median–max spread — a single judged pass is not a number.
 *
 *   bun run scripts/judge.ts --report eval/reports/<file>.json [--model zai:glm-5.2] [--judge-repeats 3]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { ModelLane } from "../src/core/types.js";
import {
  createJudge,
  type DefectLocus,
  type JudgedFinding,
  summarize,
} from "../src/eval/judge.js";
import {
  makeSpendGuard,
  openrouterPrice,
  type SpendGuard,
  type TokenPrice,
} from "./lib/spend-guard.js";

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
): Promise<{ perCase: Map<string, number[]>; perPassRecall: number[] }> {
  const perCase = new Map<string, number[]>();
  const perPassRecall: number[] = [];
  let aborted = false;
  for (let k = 0; k < ctx.repeats && !aborted; k += 1) {
    let passTotal = 0;
    for (const { r, c } of scored) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design — respects the judge model's concurrency limits AND lets the spend guard see each call's cost before the next fires
      const { grades, usage } = await judge.judge(
        c.expect_loci,
        r.findings ?? [],
        lane
      );
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
  return { perCase, perPassRecall };
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

async function main() {
  const reportPath = arg("report");
  if (!reportPath) {
    throw new Error("provide --report <path to eval/reports/*.json>");
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    results: ReportResult[];
    config?: unknown;
  };
  const manifest = (
    parseYaml(readFileSync(`${ROOT}eval/golden/manifest.yaml`, "utf8")) as {
      cases: Case[];
    }
  ).cases;
  const byId = new Map(manifest.map((c) => [c.id, c]));

  const lane = buildLane(arg("model") ?? "zai:glm-5.2");
  const judge = createJudge({ apiKeys: readKeys() });
  const repeats = parseRepeats();

  // GLM judges via z.ai are free (price {0,0} → guard never trips). Only a paid cross-family judge
  // (openrouter) accumulates real spend against --max-spend (default $0.25).
  const price =
    lane.provider === "openrouter"
      ? openrouterPrice(lane.model)
      : { in: 0, out: 0 };
  const maxSpend = Number(arg("max-spend") ?? 0.25);
  const guard = makeSpendGuard(maxSpend);
  const paid = price.in > 0 || price.out > 0;

  const scored = selectScored(report.results, byId);
  const total = scored.reduce((n, { c }) => n + c.expect_loci.length, 0);
  const fileHits = scored.reduce((n, { r }) => n + (r.hitLoci ?? 0), 0);

  console.log(`\n▸ judging ${reportPath}`);
  console.log(`  config: ${JSON.stringify(report.config ?? "(none)")}`);
  console.log(`  judge:  ${lane.provider}/${lane.model}`);
  console.log(
    `  passes: ${repeats}${paid ? `  (PAID judge — spend cap $${maxSpend})` : ""}\n`
  );

  const { perCase, perPassRecall } = await runPasses(judge, lane, scored, {
    guard,
    price,
    repeats,
    total,
  });
  printReport(scored, perCase, perPassRecall, { fileHits, repeats, total });
  if (paid) {
    console.log(
      `  judge spend (token estimate): ~$${guard.spent().toFixed(4)} of $${maxSpend} cap`
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error("judge failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
