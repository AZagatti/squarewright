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

  const judgeArg = arg("model") ?? "zai:glm-5.2";
  const lane: ModelLane = {
    id: "judge",
    model: judgeArg.slice(judgeArg.indexOf(":") + 1),
    provider: judgeArg.slice(0, judgeArg.indexOf(":")),
    thinking: "off",
  };
  const judge = createJudge({ apiKeys: readKeys() });

  // The judge is stochastic — re-scoring an identical report gives different totals (RESULTS.md: 8
  // then 7). Re-run the whole report K times and report the judge's own spread, so a config's
  // defect-recall is a range, not a point. K=1 keeps the old single-number output.
  const repeats = Math.max(1, Math.trunc(Number(arg("judge-repeats") ?? 1)));

  // Narrow to the scorable has-issue cases up front (clean cases have no defect loci to judge).
  const scored = report.results
    .map((r) => ({ c: byId.get(r.id), r }))
    .filter(
      (x): x is { r: ReportResult; c: Case & { expect_loci: DefectLocus[] } } =>
        x.c?.label === "has-issue" && !!x.c.expect_loci?.length
    );
  const total = scored.reduce((n, { c }) => n + c.expect_loci.length, 0);
  const fileHits = scored.reduce((n, { r }) => n + (r.hitLoci ?? 0), 0);

  console.log(`\n▸ judging ${reportPath}`);
  console.log(`  config: ${JSON.stringify(report.config ?? "(none)")}`);
  console.log(`  judge:  ${lane.provider}/${lane.model}`);
  console.log(`  passes: ${repeats}\n`);

  const perCase = new Map<string, number[]>();
  const perPassRecall: number[] = [];
  for (let k = 0; k < repeats; k += 1) {
    let passTotal = 0;
    for (const { r, c } of scored) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design — respects the judge model's concurrency limits across passes × offline-report cases
      const grades = await judge.judge(c.expect_loci, r.findings ?? [], lane);
      const matched = grades.filter((g) => g.matched).length;
      passTotal += matched;
      perCase.set(r.id, [...(perCase.get(r.id) ?? []), matched]);
    }
    perPassRecall.push(passTotal);
    if (repeats > 1) {
      console.log(`  pass ${k + 1}/${repeats}: defect ${passTotal}/${total}`);
    }
  }

  console.log("\n── per case (defect matches across passes) ──");
  for (const { r, c } of scored) {
    const s = summarize(perCase.get(r.id) ?? []);
    const range = s.min === s.max ? `${s.min}` : `${s.min}–${s.max}`;
    console.log(
      `  ${r.id.padEnd(28)} file=${r.hitLoci ?? 0}/${c.expect_loci.length}  defect=${range}/${c.expect_loci.length}`
    );
  }

  const overall = summarize(perPassRecall);
  console.log("\n── recall ──");
  console.log(`  FILE-level (eval metric): ${fileHits}/${total}`);
  if (repeats === 1) {
    console.log(`  DEFECT-level (judge):     ${overall.median}/${total}`);
  } else {
    console.log(
      `  DEFECT-level (judge, ${repeats} passes): ${overall.min}–${overall.max}/${total} (median ${overall.median})`
    );
    console.log(`  per-pass totals: [${perPassRecall.join(", ")}]`);
  }
  console.log(
    `  → the file metric over-credited the median by ${fileHits - overall.median} loci\n`
  );
}

main().catch((e) => {
  console.error("judge failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
