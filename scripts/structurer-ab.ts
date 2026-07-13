/**
 * Fixed-analysis structurer A/B (#40) — settles whether the STRUCTURER (pass 2) is a cheap recall lever, isolated
 * from pass-1 (analysis) non-determinism.
 *
 * The confound it removes: a plain `eval.ts --structurer X` swap re-runs the analysis each time, and analysis is
 * non-deterministic, so two structurers' structured recall differ by ANALYSIS variance, not just structurer quality
 * (dogfooded 2026-07-13: glm-5-turbo and glm-5.2 both scored 4/11 but per-case results shuffled — see
 * eval/golden/README.md). This harness instead CACHES K analysis samples per case (one pass-1 each) and runs EVERY
 * structurer on the SAME frozen prose, via the exact production pass-2 (worker.structureAnalysis). So any recall
 * gap between structurers is the structurer, period.
 *
 *   bun run scripts/structurer-ab.ts                                  # K=3, zai:glm-5-turbo vs zai:glm-5.2
 *   bun run scripts/structurer-ab.ts --k 3 --structurers zai:glm-5.2,zai:glm-5-turbo --limit 3
 *
 * Free (z.ai glm). The pass-1 harvest run uses glm-5-turbo as its structurer, so it doubles as the turbo arm — the
 * other structurers only re-structure the cached prose (cheap). Read-only: no reports/runs.jsonl writes.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { splitUnifiedDiff } from "../src/core/diff.js";
import type { ReviewContext } from "../src/core/types.js";
import { sameFile } from "../src/eval/locus-match.js";
import { createModelRegistry } from "../src/pi/model-catalog.js";
import { createPiWorker, structureAnalysis } from "../src/pi/worker.js";

const ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST = `${ROOT}eval/golden/manifest.yaml`;
const DIFFS = `${ROOT}eval/golden/diffs`;

// Same bare persona as a plain `eval.ts --model glm-5.2` run, so the analysis matches the 4/11 golden baseline.
const PERSONA = `You are a careful senior code reviewer reviewing a single pull request.
Review ONLY the changes in the diff. Flag correctness bugs, security issues, and clear regressions.
Ground every finding in the diff — do not speculate about code you cannot see. Prefer a few high-signal
findings over many nits. If the change looks fine, submit an empty findings array.`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Locus {
  about: string;
  path: string;
}
interface Case {
  expect_loci?: Locus[];
  id: string;
  label: "clean" | "has-issue";
  pr: number;
  repo: string;
  stack: string;
}

const K = Math.max(1, Math.trunc(Number(arg("k") ?? 3)));
const TURBO = {
  model: "glm-5-turbo",
  provider: "zai",
  thinking: "off" as const,
};
const structurers = (arg("structurers") ?? "zai:glm-5-turbo,zai:glm-5.2")
  .split(",")
  .map((s) => {
    const [provider, model] = [
      s.slice(0, s.indexOf(":")),
      s.slice(s.indexOf(":") + 1),
    ];
    return { model, provider, thinking: "off" as const };
  });
const idFilter = arg("id");
const limit = arg("limit") ? Number(arg("limit")) : undefined;

const zai = (
  process.env.ZAI_API_KEY ?? readFileSync(`${homedir()}/.zai_key`, "utf8")
).trim();
const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey("zai", zai);
const modelRegistry = createModelRegistry(authStorage);
// The harvest worker's structurer IS the turbo arm — reused so we never pay a wasted structurer call.
const harvestWorker = createPiWorker({
  apiKeys: { zai },
  structurerLane: TURBO,
});

const doc = parseYaml(readFileSync(MANIFEST, "utf8")) as { cases: Case[] };
// biome-ignore lint/suspicious/noUnnecessaryConditions: runtime guard against a malformed/empty manifest.yaml — the `as` cast doesn't validate at runtime
let cases = (doc.cases ?? []).filter(
  (c) => c.label === "has-issue" && c.expect_loci?.length
);
if (idFilter) {
  cases = cases.filter((c) => c.id === idFilter);
}
if (limit !== undefined) {
  cases = cases.slice(0, limit);
}

function ctxOf(c: Case): ReviewContext {
  const diff = readFileSync(`${DIFFS}/${c.id}.diff`, "utf8").slice(0, 60_000);
  return {
    baseSha: "",
    body: "",
    files: splitUnifiedDiff(diff),
    headSha: "",
    prNumber: c.pr,
    repo: c.repo,
    title: `${c.repo}#${c.pr}`,
  };
}

function hits(findings: { path: string }[], loci: Locus[]): number {
  return loci.filter((l) => findings.some((f) => sameFile(f.path, l.path)))
    .length;
}

const laneKey = (l: { provider: string; model: string }) =>
  `${l.provider}/${l.model}`;
// per-structurer running totals: hit loci / total loci across every (case, sample)
const tally = new Map<string, { hit: number; total: number; empty: number }>();
for (const s of structurers) {
  tally.set(laneKey(s), { empty: 0, hit: 0, total: 0 });
}

console.log(
  `\n▸ structurer A/B  k=${K}  structurers=${structurers.map(laneKey).join(", ")}  cases=${cases.length} (has-issue)  analysis=zai/glm-5.2 (frozen per sample)\n`
);

for (const c of cases) {
  const context = ctxOf(c);
  const loci = c.expect_loci ?? [];
  for (let k = 0; k < K; k += 1) {
    // 1) harvest ONE analysis sample (pass-1) — this run's structurer is glm-5-turbo (the turbo arm, free).
    // biome-ignore lint/performance/noAwaitInLoops: sequential to respect the free provider's concurrency limits
    const harvest = await harvestWorker.run({
      context,
      lane: { model: "glm-5.2", provider: "zai", thinking: "off" },
      persona: "persona:general",
      systemPrompt: PERSONA,
    });
    const analysisText = harvest.usage?.analysisText ?? "";

    const perStruct: string[] = [];
    for (const s of structurers) {
      // reuse the harvest run's findings for the turbo arm; re-structure the frozen prose for the others.
      let { findings } = harvest;
      if (laneKey(s) !== laneKey(TURBO)) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential to respect the free provider's concurrency limits
        const structured = await structureAnalysis(
          analysisText,
          {
            persona: "persona:general",
            proposeRuleDrift: false,
            structLane: s,
          },
          { authStorage, modelRegistry }
        );
        ({ findings } = structured);
      }
      const h = hits(findings, loci);
      const t = tally.get(laneKey(s));
      if (t) {
        t.hit += h;
        t.total += loci.length;
        if (findings.length === 0) {
          t.empty += 1;
        }
      }
      perStruct.push(
        `${laneKey(s)}=${h}/${loci.length}(raw ${findings.length})`
      );
    }
    console.log(`[${c.id.padEnd(26)} k${k + 1}] ${perStruct.join("  ")}`);
  }
}

console.log(
  "\n── structurer recall on FROZEN analysis (isolated from pass-1 variance) ──"
);
for (const s of structurers) {
  const t = tally.get(laneKey(s));
  if (t) {
    const pct = t.total ? ((100 * t.hit) / t.total).toFixed(0) : "0";
    console.log(
      `  ${laneKey(s).padEnd(20)} locus recall ${t.hit}/${t.total} (${pct}%)  ·  empty-extractions ${t.empty}/${cases.length * K}`
    );
  }
}
console.log(
  "\nInterpretation: same frozen prose → recall differences here are the STRUCTURER alone. If a stronger structurer\nbeats glm-5-turbo, it is a cheap recall lever; if they tie, the drop is inherent to the extraction task, not the model.\n"
);
