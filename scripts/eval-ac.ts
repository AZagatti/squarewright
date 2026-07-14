/**
 * AC-conformance eval: measure whether the built-but-never-measured `acCheck` pass reliably catches a SILENTLY-unmet
 * acceptance criterion while staying quiet on clean and transparently-disclosed PRs. Corpus = the 8 hand-verified
 * self-repo cases in eval/ac/cases.md (5 clean controls, 2 disclosed-gap, 1 gold silent miss `ac-sw-70`).
 *
 * This is the follow-on measurement round eval/ac/cases.md line ~332 named but never ran: "an eval-style pass where a
 * model is asked 'does this diff satisfy every AC in this issue' against these 8 labeled cases to see if it reproduces
 * the ac-sw-70 miss." The AC design (src/init/default-config.ts) requires a STRONG model — a free/small one is
 * unreliable at the silent-vs-justified judgment — so the analysis pass runs through the Codex subscription CLI (a
 * zero-API-cost test instrument, same as scripts/eval-codex.ts). Pass-2 structuring stays on free glm-5.2.
 *
 * FAITHFUL to production: the prompt is composed by the SAME exported functions the real worker uses —
 * buildAnalysisSystem({acCheck:true}) for the system turn (persona + ANALYSIS_NOTE + AC_CHECK_NOTE) and
 * renderAnalysisPrompt(ctx, true) for the user turn (PR title/body/diff + the fenced, defanged, UNTRUSTED linked
 * issue). No production code is changed.
 *
 *   bun run scripts/eval-ac.ts --model gpt-5.6-terra [--effort low] [--repeats 3] [--id ac-sw-70] [--refresh]
 *
 * Scoring: for expect=flag (gold) a run "catches" iff it emits ≥1 finding; for expect=quiet (clean/disclosed) any
 * finding is a FALSE POSITIVE. Reported as a per-case flag-count over N runs (the ≥3-run range discipline). The gold
 * catch still needs a manual on-target check (is the finding about the ship gate?) — run with SQW_DUMP_RAW=1 to keep
 * rawAnalysis in the report for that.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Finding, ModelLane, ReviewContext } from "../src/core/types.js";
import { createModelRegistry } from "../src/pi/model-catalog.js";
import type { WorkerRequest } from "../src/pi/session.js";
import { agentSessionSettings } from "../src/pi/settings.js";
import {
  buildAnalysisSystem,
  buildFindingsSchema,
  buildStructurerSystem,
  capRuleDrift,
  renderAnalysisPrompt,
  submittedToFinding,
} from "../src/pi/worker.js";

const ROOT = new URL("..", import.meta.url).pathname;
const REPO = "AZagatti/squarewright";
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// The AC-conformance persona a real user would configure — verbatim from src/init/default-config.ts's opt-in example.
// The actual silent-vs-justified judgment logic lives in AC_CHECK_NOTE, which buildAnalysisSystem appends.
const AC_PERSONA =
  "You audit whether the PR satisfies the linked issue's acceptance criteria.";

interface SubmittedFinding {
  line?: number;
  message: string;
  path: string;
  severity?: string;
}

interface Fixture {
  diff: string;
  issue: { body: string; number: number; title: string };
  pr: { body: string; number: number; title: string };
}

interface AcCase {
  expect: "flag" | "quiet";
  id: string;
  issue: number;
  kind: string;
  note: string;
  pr: number;
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

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

/** Fetch (issue AC text + PR title/body + merged diff) via gh; cached to eval/ac/fixtures/<id>.json for reproducibility. */
function loadFixture(c: AcCase, refresh: boolean): Fixture {
  const dir = join(ROOT, "eval/ac/fixtures");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${c.id}.json`);
  if (!refresh && existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as Fixture;
  }
  const issue = JSON.parse(
    gh([
      "issue",
      "view",
      String(c.issue),
      "-R",
      REPO,
      "--json",
      "number,title,body",
    ])
  ) as Fixture["issue"];
  const pr = JSON.parse(
    gh(["pr", "view", String(c.pr), "-R", REPO, "--json", "number,title,body"])
  ) as Fixture["pr"];
  const diff = gh(["pr", "diff", String(c.pr), "-R", REPO]);
  const fx: Fixture = { diff, issue, pr };
  writeFileSync(path, JSON.stringify(fx, null, 2));
  return fx;
}

/** Compose the production AC-conformance prompt for the CLI: exact worker system turn + user turn, concatenated. */
function composeAcPrompt(fx: Fixture): string {
  const ctx: ReviewContext = {
    baseSha: "",
    body: fx.pr.body,
    files: [{ patch: fx.diff, path: "(merged diff)", status: "modified" }],
    headSha: "",
    linkedIssue: {
      body: fx.issue.body,
      number: fx.issue.number,
      title: fx.issue.title,
    },
    prNumber: fx.pr.number,
    repo: REPO,
    title: fx.pr.title,
  } as ReviewContext;
  const system = buildAnalysisSystem({
    acCheck: true,
    systemPrompt: AC_PERSONA,
  } as WorkerRequest);
  const userTurn = renderAnalysisPrompt(ctx, true);
  return `${system}\n\n${userTurn}`;
}

/** Pass-1 analysis via `codex exec` in a fresh empty temp dir; full prompt passed as one literal arg (no shell). */
function codexAnalysis(
  model: string,
  effort: string | undefined,
  prompt: string
): { status: "error" | "ok" | "timeout"; text: string } {
  const dir = mkdtempSync(join(tmpdir(), "sqw-ac-"));
  const outFile = join(dir, "out.txt");
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
      timeout: 300_000,
    });
    return { status: "ok", text: readOut() };
  } catch (e) {
    const err = e as { code?: string; signal?: string };
    const timedOut = err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    const salvaged = readOut();
    if (salvaged) {
      return { status: "ok", text: salvaged };
    }
    return { status: timedOut ? "timeout" : "error", text: "" };
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
    submitted.map((f) => submittedToFinding(f, "persona:auditor", false))
  );
}

interface CaseResult {
  catches: number;
  expect: string;
  flags: number[];
  id: string;
  kind: string;
  runs: {
    findings: { line?: number; message: string; path: string }[];
    n: number;
    rawAnalysis?: string;
    status: string;
  }[];
}

async function main() {
  const model = arg("model") ?? "gpt-5.6-terra";
  const effort = arg("effort");
  const effortLabel = effort ?? "none";
  const repeats = Number(arg("repeats") ?? "3");
  const only = arg("id");
  const refresh = process.argv.includes("--refresh");
  const dumpRaw = process.env.SQW_DUMP_RAW === "1";

  const structLane: ModelLane = {
    id: "structurer",
    model: "glm-5.2",
    provider: "zai",
    thinking: "off",
  };
  const { parse } = await import("yaml");
  const { cases: allCases } = parse(
    readFileSync(join(ROOT, "eval/ac/manifest.yaml"), "utf8")
  ) as { cases: AcCase[] };
  const cases = only ? allCases.filter((c) => c.id === only) : allCases;
  const keys = readZaiKey();

  console.log(
    `\n▸ eval-ac  analysis=codex/${model}@${effortLabel}  structurer=zai/glm-5.2  repeats=${repeats}  cases=${cases.length}\n`
  );
  const results: CaseResult[] = [];
  for (const c of cases) {
    const fx = loadFixture(c, refresh);
    const prompt = composeAcPrompt(fx);
    const runs: CaseResult["runs"] = [];
    const flags: number[] = [];
    for (let r = 0; r < repeats; r += 1) {
      const { text: analysis, status } = codexAnalysis(model, effort, prompt);
      let findings: Finding[] = [];
      if (analysis) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential structurer call per run
        findings = await structure(analysis, keys, structLane);
      }
      flags.push(findings.length);
      runs.push({
        findings: findings.map((f) => ({
          line: f.line,
          message: f.message,
          path: f.path,
        })),
        n: r + 1,
        status,
        ...(dumpRaw ? { rawAnalysis: analysis } : {}),
      });
    }
    // "catch" = emitted ≥1 finding. For expect=flag that's a true positive; for expect=quiet it's a false positive.
    const catches = flags.filter((f) => f > 0).length;
    const verdict =
      c.expect === "flag"
        ? `caught ${catches}/${repeats}`
        : `FALSE-POS ${catches}/${repeats}`;
    console.log(
      `  [${c.expect.padEnd(5)} ${c.kind.padEnd(13)}] ${c.id.padEnd(10)} flags=[${flags.join(",")}]  ${verdict}`
    );
    results.push({
      catches,
      expect: c.expect,
      flags,
      id: c.id,
      kind: c.kind,
      runs,
    });
  }

  // Aggregate: gold recall + clean/disclosed false-positive rate.
  const gold = results.filter((r) => r.expect === "flag");
  const quiet = results.filter((r) => r.expect === "quiet");
  const goldCatch = gold.reduce((s, r) => s + r.catches, 0);
  const goldTotal = gold.length * repeats;
  const fpRuns = quiet.reduce((s, r) => s + r.catches, 0);
  const fpTotal = quiet.length * repeats;
  const fpCases = quiet.filter((r) => r.catches > 0).length;
  console.log(
    `\n  GOLD recall: ${goldCatch}/${goldTotal} runs caught the silent miss` +
      `\n  QUIET false-positives: ${fpRuns}/${fpTotal} runs flagged a clean/disclosed case (${fpCases}/${quiet.length} cases ever tripped)\n`
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modelSlug = model.replace(/[^a-z0-9.-]/gi, "_");
  const reportPath = join(
    ROOT,
    `eval/reports/ac-${modelSlug}-${effortLabel}-r${repeats}-${stamp}.json`
  );
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        config: {
          analysis: `codex-cli/${model}`,
          effort: effortLabel,
          repeats,
          structurer: "zai/glm-5.2",
        },
        results,
        summary: { fpCases, fpRuns, fpTotal, goldCatch, goldTotal },
      },
      null,
      2
    )
  );
  console.log(`  report: ${reportPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
