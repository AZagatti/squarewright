/**
 * Offline defect-match judge: re-scores a saved eval report against ground truth using an LLM judge, so we
 * see real DEFECT recall (did a finding describe the actual bug?) vs the loose FILE recall the eval prints.
 * Reuses saved findings — no worker re-run. Default judge = free z.ai glm-5.2.
 *
 *   bun run scripts/judge.ts --report eval/reports/<file>.json [--model zai:glm-5.2]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { ModelLane } from "../src/core/types.js";
import {
  createJudge,
  type DefectLocus,
  type JudgedFinding,
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

  console.log(`\n▸ judging ${reportPath}`);
  console.log(`  config: ${JSON.stringify(report.config ?? "(none)")}`);
  console.log(`  judge:  ${lane.provider}/${lane.model}\n`);

  let fileHits = 0;
  let defectHits = 0;
  let total = 0;
  for (const r of report.results) {
    const c = byId.get(r.id);
    if (c?.label !== "has-issue" || !c.expect_loci?.length) {
      continue;
    }
    const n = c.expect_loci.length;
    total += n;
    fileHits += r.hitLoci ?? 0;
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design — respects the judge model's concurrency limits across offline-report cases
    const grades = await judge.judge(c.expect_loci, r.findings ?? [], lane);
    const matched = grades.filter((g) => g.matched).length;
    defectHits += matched;
    console.log(
      `  ${r.id.padEnd(28)} file=${r.hitLoci ?? 0}/${n}  defect=${matched}/${n}`
    );
  }

  console.log("\n── recall ──");
  console.log(`  FILE-level (eval metric): ${fileHits}/${total}`);
  console.log(`  DEFECT-level (judge):     ${defectHits}/${total}`);
  console.log(
    `  → the file metric over-credited by ${fileHits - defectHits} loci\n`
  );
}

main().catch((e) => {
  console.error("judge failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
