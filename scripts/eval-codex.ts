/**
 * Codex-analysis eval: drive squarewright's ANALYSIS pass through the Codex CLI (`codex exec`, backed by the user's
 * ChatGPT/Codex subscription) instead of `claude -p`. The fixed glm-5.2 structurer (Pass 2, same as the real worker)
 * extracts findings, so this isolates the GPT model's REVIEW quality on the same corpus/harness. Writes
 * judge-compatible reports so `scripts/judge.ts` scores defect-level recall exactly as for API / claude-cli models.
 *
 * Mirrors scripts/eval-cli.ts — ONLY the pass-1 analysis differs (codex exec vs claude -p). Isolation: codex runs in
 * a FRESH empty temp dir (nothing to explore) with the diff passed IN the prompt, so it reviews only the provided
 * diff — the codex analog of eval-cli's `--tools ""`.
 *
 *   bun run scripts/eval-codex.ts --model gpt-5.6-sol [--effort high] [--manifest ...] [--stack rust] [--id <case>]
 *   then: bun run scripts/judge.ts --report eval/reports/codex-<model>-<stamp>.json [--manifest ...]
 *
 * Analysis = subscription CLI (no API cost; codex prints tokens to stderr, so cost is recorded as 0).
 * Structuring = free zai glm-5.2. Judge = separate step. Reasoning effort: none (default/off), low, medium, high, …
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

const COT_SCAFFOLD_TAIL = `

Work through the review in three explicit, ordered steps:
1. UNDERSTAND — briefly state what the changed code does and what the diff is trying to achieve.
2. FIND — given that understanding, list every candidate bug, correctness issue, or regression the change could introduce.
3. VERIFY — for each candidate, critically decide whether it is a REAL defect that THIS PR's changed lines introduce, or a false positive; keep only the ones you are confident are real and drop the rest.
Your final review must contain only the issues that survived step 3.`;

const SURVEYOR_TAIL = `

Before you finish, do a coverage pass: for EACH issue you identified, check EVERY other changed file and hunk in
this diff for the SAME underlying root cause, and report each additional occurrence as its own finding. A change
applied in one place but not its siblings is a common defect, so a bug you found once may recur elsewhere in this
diff. Do this now, in this same response, before concluding.`;

/** Compose the analysis persona with the opt-in prompt tails (same stacking order as buildAnalysisSystem). */
function analysisPersona(scaffold: boolean, surveyor: boolean): string {
  return (
    PERSONA +
    (scaffold ? COT_SCAFFOLD_TAIL : "") +
    (surveyor ? SURVEYOR_TAIL : "")
  );
}

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
 * Pass-1 analysis via `codex exec`. Isolation: a fresh empty temp dir as the workspace (`-C`) + the diff embedded in
 * the prompt means codex reviews ONLY the provided diff — it has nothing else to read. `execFileSync` (no shell)
 * passes the prompt as one literal arg, so a diff with backticks/`$` needs no escaping. Reasoning effort maps to
 * `-c model_reasoning_effort=<effort>` (default `none` = off). codex writes the final message to `-o`; token/cost go
 * to stderr (not machine-readable here), so cost is recorded as 0 (the run is on the subscription anyway).
 */
function codexAnalysis(
  model: string,
  effort: string | undefined,
  diff: string,
  persona: string
): { cost: number; status: "error" | "ok" | "timeout"; text: string } {
  const dir = mkdtempSync(join(tmpdir(), "sqw-codex-"));
  const outFile = join(dir, "out.txt");
  const prompt = `${persona}\n\nReview this pull request diff and report every issue you find:\n\n${diff}`;
  const args = [
    "exec",
    "-m",
    model,
    "-c",
    `model_reasoning_effort=${effort ?? "none"}`,
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    dir,
    "-o",
    outFile,
    prompt,
  ];
  const readOut = (): string => {
    try {
      return readFileSync(outFile, "utf8").trim();
    } catch {
      return "";
    }
  };
  try {
    execFileSync("codex", args, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
    });
    return { cost: 0, status: "ok", text: readOut() };
  } catch (e) {
    const err = e as { code?: string; signal?: string };
    const timedOut = err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    // codex can exit non-zero yet still have written a usable final message — salvage it before giving up.
    const salvaged = readOut();
    if (salvaged) {
      return { cost: 0, status: "ok", text: salvaged };
    }
    return { cost: 0, status: timedOut ? "timeout" : "error", text: "" };
  } finally {
    rmSync(dir, { force: true, recursive: true });
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mirrors eval-cli.ts's main — a linear case loop, not real branching complexity
async function main() {
  const model = arg("model") ?? "gpt-5.6-sol";
  const effort = arg("effort");
  const effortLabel = effort ?? "none";
  const suffix = `-${effortLabel}`;
  const doScaffold = process.argv.includes("--cot-scaffold");
  const doSurveyor = process.argv.includes("--surveyor");
  const persona = analysisPersona(doScaffold, doSurveyor);
  // Structurer pinned to zai:glm-5.2 by default — matches the claude-cli + paid model rank so scores are comparable.
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
    `\n▸ eval-codex  analysis=codex/${model}@${effortLabel}  structurer=${structLane.provider}/${structLane.model}  cases=${cases.length}\n`
  );
  const results: unknown[] = [];
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
    } = codexAnalysis(model, effort, diff, persona);
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
      ...(process.env.SQW_DUMP_RAW === "1" ? { rawAnalysis: analysis } : {}),
      status,
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modelSlug = model.replace(/[^a-z0-9.-]/gi, "_");
  const reportPath = `${ROOT}eval/reports/codex-${modelSlug}${suffix}${doScaffold ? "-cotscaffold" : ""}${doSurveyor ? "-surveyor" : ""}-${stamp}.json`;
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        config: {
          analysis: `codex-cli/${model}`,
          cotScaffold: doScaffold,
          effort: effortLabel,
          model,
          provider: "codex",
          structurer: `${structLane.provider}/${structLane.model}`,
          surveyor: doSurveyor,
        },
        results,
      },
      null,
      2
    )
  );
  console.log(
    `\n  report: ${reportPath}\n  judge: bun run scripts/judge.ts --report ${reportPath}${manifestPath.includes("contam") ? " --manifest eval/contam-safe/manifest.yaml" : ""}\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
