/**
 * CLI-analysis eval: drive squarewright's ANALYSIS pass through `claude -p` (the Claude Code CLI, backed by the
 * user's Max/Pro SUBSCRIPTION — the ToS-legitimate way to use it, unlike wiring subscription auth into the API).
 * The fixed glm-5.2 structurer (Pass 2, same as the real worker) then extracts findings, so this isolates the
 * Claude model's REVIEW quality on the same corpus/harness. Writes judge-compatible reports so `scripts/judge.ts`
 * scores defect-level recall exactly as for API models.
 *
 *   bun run scripts/eval-cli.ts --model claude-sonnet-5 [--effort high] [--manifest eval/golden/manifest.yaml] [--stack rust]
 *   then: bun run scripts/judge.ts --report eval/reports/cli-<model>-<stamp>.json [--manifest ...]
 *
 * Analysis = subscription CLI (no API cost). Structuring = free zai glm-5.2. Judge = separate step.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Finding, ModelLane } from "../src/core/types.js";
import { sameFile } from "../src/eval/locus-match.js";
import { createModelRegistry } from "../src/pi/model-catalog.js";
import { agentSessionSettings } from "../src/pi/settings.js";
import {
  buildFindingsSchema,
  buildStructurerSystem,
  capRuleDrift,
  submittedToFinding,
} from "../src/pi/worker.js";

const ROOT = new URL("..", import.meta.url).pathname;
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const PERSONA = `You are a careful senior code reviewer reviewing a single pull request.
Review ONLY the changes in the diff. Flag correctness bugs, security issues, and clear regressions.
Ground every finding in the diff — do not speculate about code you cannot see. Prefer a few high-signal
findings over many nits. If the change looks fine, say so. Write your review as prose: for every issue,
state the file path, line number, a severity (error/warning/info), and why it is a problem.`;

interface SubmittedFinding {
  line?: number;
  message: string;
  path: string;
  severity?: string;
}

function readZaiKey(): Record<string, string> {
  const keys: Record<string, string> = {};
  try {
    keys.zai = (
      process.env.ZAI_API_KEY ?? readFileSync(`${homedir()}/.zai_key`, "utf8")
    ).trim();
  } catch {
    /* no zai key */
  }
  return keys;
}

/**
 * Pass-1 analysis via `claude -p` on the SUBSCRIPTION. CRITICAL flags (learned from trimwire's harness):
 * `--safe-mode --tools ""` — without them the CLI tool-calls into the HARNESS's own repo (runs `git diff`,
 * reviews the live tree) instead of the injected diff, and picks up ai-memory SessionStart-hook contamination;
 * disabling tools forces a clean single-turn text review (also ~7× cheaper — no tool-schema overhead).
 * `--output-format json` gives a parseable envelope with `.is_error` (plain stdout would accept a "Not logged
 * in" error as if it were review text). Diff goes via stdin (avoids ARG_MAX). Returns text + a status label.
 */
function claudeAnalysis(
  model: string,
  effort: string | undefined,
  diff: string
): { cost: number; status: "error" | "ok" | "timeout"; text: string } {
  const args = [
    "-p",
    "--safe-mode",
    "--tools",
    "",
    "--output-format",
    "json",
    "--model",
    model,
    "--append-system-prompt",
    PERSONA,
  ];
  if (effort) {
    args.push("--effort", effort);
  }
  // env hygiene — drop ANTHROPIC_BASE_URL so nothing ambient redirects the endpoint
  const { ANTHROPIC_BASE_URL: _drop, ...env } = process.env;
  try {
    const raw = execFileSync("claude", args, {
      encoding: "utf8",
      env,
      input: `Review this pull request diff and report every issue you find:\n\n${diff}`,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 240_000,
    });
    const j = JSON.parse(raw) as {
      is_error?: boolean;
      result?: string;
      total_cost_usd?: number;
    };
    const cost = j.total_cost_usd ?? 0;
    if (j.is_error) {
      return { cost, status: "error", text: "" };
    }
    return { cost, status: "ok", text: (j.result ?? "").trim() };
  } catch (e) {
    const err = e as { code?: string; signal?: string };
    const timedOut = err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    return { cost: 0, status: timedOut ? "timeout" : "error", text: "" };
  }
}

/** Pass-2 structurer — replicates src/pi/worker.ts Pass 2 (fixed extractor, no reasoning, submit_findings). */
async function structure(
  analysisText: string,
  keys: Record<string, string>,
  lane: ModelLane
): Promise<Finding[]> {
  const authStorage = AuthStorage.create();
  for (const [p, k] of Object.entries(keys)) {
    authStorage.setRuntimeApiKey(p, k);
  }
  const modelRegistry = createModelRegistry(authStorage);
  const model = modelRegistry.find(lane.provider, lane.model);
  if (!model) {
    throw new Error(
      `Structurer model not found: ${lane.provider}/${lane.model}`
    );
  }
  let captured: { summary: string; findings: SubmittedFinding[] } | undefined;
  const submitFindings = defineTool({
    description:
      "Submit the structured findings extracted from the analysis. Call exactly once.",
    execute: (_id, params) => {
      captured = params as { summary: string; findings: SubmittedFinding[] };
      return Promise.resolve({
        content: [
          { text: `Recorded ${captured.findings.length}.`, type: "text" },
        ],
        details: {},
      });
    },
    label: "Submit findings",
    name: "submit_findings",
    parameters: buildFindingsSchema(false),
  });
  const loader = new DefaultResourceLoader({
    agentDir: getAgentDir(),
    cwd: process.cwd(),
    systemPromptOverride: () => buildStructurerSystem(false),
  });
  await loader.reload();
  const { session } = await createAgentSession({
    authStorage,
    customTools: [submitFindings],
    model,
    modelRegistry,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: (agentSessionSettings as () => SettingsManager)(),
    thinkingLevel: lane.thinking ?? "off",
  });
  const text = analysisText.length > 0 ? analysisText : "(no analysis text)";
  await session.prompt(
    `Extract the findings from this code-review analysis into submit_findings (empty array if no issues):\n\n${text}`
  );
  let n = 0;
  while (captured === undefined && n < 2) {
    n += 1;
    // biome-ignore lint/performance/noAwaitInLoops: sequential nudge, only if the prior failed
    await session.prompt(
      "Call submit_findings now, exactly once (empty array if none)."
    );
  }
  session.dispose();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the nudge loop can exit with captured still undefined
  const submitted = captured?.findings ?? [];
  return capRuleDrift(
    submitted.map((f) => submittedToFinding(f, "persona:general", false))
  );
}

interface Case {
  expect_loci?: { path: string }[];
  id: string;
  label: string;
}

/**
 * Report labeling. `claude -p` has NO reasoning-off effort value (default effort == high per docs), so the real
 * off lane is env `MAX_THINKING_TOKENS=0`. A no-`--effort` run is therefore "off" only when that env is set, else
 * "default" — detect it so the report is self-documenting and the filename suffix stays unambiguous.
 */
function reportLabels(effort: string | undefined): {
  effortLabel: string;
  suffix: string;
  thinkOff: boolean;
} {
  const thinkOff = process.env.MAX_THINKING_TOKENS === "0";
  const effortLabel = effort ?? (thinkOff ? "off" : "default");
  let suffix = "";
  if (effort) {
    suffix = `-${effort}`;
  } else if (thinkOff) {
    suffix = "-off";
  }
  return { effortLabel, suffix, thinkOff };
}

async function main() {
  const model = arg("model") ?? "claude-sonnet-5";
  const effort = arg("effort");
  const { effortLabel, suffix, thinkOff } = reportLabels(effort);
  // Structurer pinned to zai:glm-5.2 by default — matches the paid model rank (#94) so scores are comparable.
  const structArg = arg("structurer") ?? "zai:glm-5.2";
  const structLane: ModelLane = {
    id: "structurer",
    model: structArg.slice(structArg.indexOf(":") + 1),
    provider: structArg.slice(0, structArg.indexOf(":")),
    thinking: "off",
  };
  const manifestPath = arg("manifest") ?? `${ROOT}eval/golden/manifest.yaml`;
  const diffDir = join(dirname(manifestPath), "diffs");
  const stack = arg("stack");
  const only = arg("id");
  const { parse } = await import("yaml");
  const { cases: allCases } = parse(readFileSync(manifestPath, "utf8")) as {
    cases: (Case & { stack?: string })[];
  };
  let cases = allCases;
  if (stack) {
    cases = cases.filter((c) => c.stack === stack);
  }
  if (only) {
    cases = cases.filter((c) => c.id === only);
  }
  const keys = readZaiKey();
  console.log(
    `\n▸ eval-cli  analysis=claude/${model}@${effortLabel}  structurer=${structLane.provider}/${structLane.model}  cases=${cases.length}\n`
  );
  const results: unknown[] = [];
  let totalCost = 0;
  for (const c of cases) {
    const t0 = Date.now();
    let diff = "";
    try {
      diff = readFileSync(join(diffDir, `${c.id}.diff`), "utf8");
    } catch {
      console.log(`  ${c.id}: no diff, skipping`);
      continue;
    }
    const {
      text: analysis,
      status,
      cost,
    } = claudeAnalysis(model, effort, diff);
    totalCost += cost;
    let findings: Finding[] = [];
    if (analysis) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design — one subscription-rate-limited review at a time
      findings = await structure(analysis, keys, structLane);
    }
    const loci = c.expect_loci ?? [];
    const hitLoci = loci.filter((l) =>
      findings.some((f) => sameFile(f.path, l.path))
    ).length;
    const ms = Date.now() - t0;
    console.log(
      `  [${c.label === "clean" ? "clean    " : "has-issue"}] ${c.id.padEnd(28)} raw=${findings.length} hits=${hitLoci}/${loci.length} ${status === "ok" ? "" : `(${status.toUpperCase()})`} ${(ms / 1000).toFixed(0)}s`
    );
    results.push({
      cost,
      findings: findings.map((f) => ({
        line: f.line,
        message: f.message,
        path: f.path,
        severity: f.severity,
      })),
      hitLoci,
      id: c.id,
      label: c.label,
      lociTotal: loci.length,
      ms,
      status,
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modelSlug = model.replace(/[^a-z0-9.-]/gi, "_");
  const reportPath = `${ROOT}eval/reports/cli-${modelSlug}${suffix}-${stamp}.json`;
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        config: {
          analysis: `claude-cli/${model}`,
          effort: effortLabel,
          structurer: `${structLane.provider}/${structLane.model}`,
          thinkingDisabled: thinkOff,
          totalCostUsd: totalCost,
        },
        results,
      },
      null,
      2
    )
  );
  console.log(
    `\n  subscription cost (analysis, from claude -p): $${totalCost.toFixed(4)} over ${results.length} cases\n  report: ${reportPath}\n  judge: bun run scripts/judge.ts --report ${reportPath}${manifestPath.includes("contam") ? " --manifest eval/contam-safe/manifest.yaml" : ""}\n`
  );
}

main().catch((e) => {
  console.error("eval-cli failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
