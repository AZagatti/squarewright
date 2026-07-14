/**
 * Multi-vendor defect-match judge. One `--vendor` flag routes the SAME grading job to any judge backend:
 *
 *   CLI vendors (subscription, the *-headless skills) — claude · codex · grok · agy
 *     → shell the CLI, ask for STRICT JSON grades in the reply, parse them. NO custom-tool-calling, which is
 *       exactly what the API judges choke on (see below). Genuinely cross-family vs a GLM reviewer, free on the
 *       subscription, no OpenRouter, no per-token spend.
 *   API vendors (Pi model registry + the submit_grades tool) — glm · opencode · openrouter
 *     → the existing src/eval/judge.ts machinery (createJudge). Kept for completeness / same-family glm baseline.
 *
 * Why CLI judges exist (measured 2026-07-14): the cross-family API judges are UNRELIABLE at the submit_grades
 * custom-tool call thinking-off — free OpenRouter deepseek-v3.2 dropped it 81/81, and the flat-fee opencode
 * Go-tier models (kimi-k2.6 off AND low, deepseek-v4-pro) drop it 9/9 (an opencode-endpoint custom-tool issue,
 * not a reasoning one). A CLI judge sidesteps tool-calling entirely. Judge is a classification task, so reasoning
 * barely helps (off≈low≈high, ±1) — default effort is low per the maintainer's "low effort, any model is fine".
 *
 * The grading contract is verbatim from src/eval/judge.ts's SYSTEM prompt; the defect⊆file structural guard is
 * reused, so a CLI judge scores like the API judge. Judge numbers are noisy (±2–4 by judge AND run-to-run) — take
 * ranges over ≥3 reports and cross-check two vendors before recording an absolute number.
 *
 *   bun run scripts/judge-cli.ts --report eval/reports/<f>.json [--vendor claude] [--model M] [--effort low] [--repeats 3]
 *   bun run scripts/judge-cli.ts --reports "a.json,b.json" --vendor codex --model gpt-5.6-terra
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelLane, ThinkingLevel } from "../src/core/types.js";
import { createJudge, type DefectLocus } from "../src/eval/judge.js";
import { sameFile } from "../src/eval/locus-match.js";

const ROOT = new URL("..", import.meta.url).pathname;
// The grades JSON object in a CLI model's reply (may be fenced or wrapped in stray prose despite instructions).
const GRADES_JSON_RE = /\{[\s\S]*"grades"[\s\S]*\}/;
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// Verbatim from src/eval/judge.ts SYSTEM — the strict same-root-cause-and-location contract (the trailing
// "Call submit_grades exactly once" is dropped; a CLI judge returns JSON instead).
const GRADING_CONTRACT = `You grade a code reviewer against known ground-truth defects in a pull request. For each known
defect, decide whether ANY of the reviewer's findings correctly identifies the SAME underlying problem — same
root cause and location, not merely the same file or a superficial mention. Be strict: a finding that lands on
the right file but describes a different issue does NOT match.`;

const OUTPUT_INSTRUCTION = `

Output ONLY a single JSON object, no prose before or after, of the form:
{"grades":[{"case":"<case-id>","defect":<0-based index within that case>,"matched":true|false,"why":"<short>"}]}
Include exactly one entry per known defect across all cases shown. "matched" is true only for a genuine same-root-cause catch.`;

const CLI_VENDORS = ["claude", "codex", "grok", "agy"] as const;
const API_VENDORS = ["glm", "opencode", "openrouter"] as const;
type CliVendor = (typeof CLI_VENDORS)[number];
type Vendor = CliVendor | (typeof API_VENDORS)[number];

/** Per-vendor default judge model (overridable with --model). Empty = the CLI/provider's own default or required. */
const DEFAULT_MODEL: Record<Vendor, string> = {
  agy: "Gemini 3.5 Flash (Low)", // agy bakes effort into the model name
  claude: "", // claude -p uses its own default model
  codex: "gpt-5.6-terra",
  glm: "zai:glm-5.2",
  grok: "grok-4.5",
  opencode: "", // required — no reliable default (opencode Go-tier models drop the tool)
  openrouter: "", // required
};

interface Finding {
  line?: number;
  message: string;
  path: string;
}
interface Result {
  findings?: Finding[];
  id: string;
  label?: string;
}
interface Report {
  config?: Record<string, unknown>;
  results?: Result[];
}
interface GoldenCase {
  expect_loci?: DefectLocus[];
  id: string;
  label: "clean" | "has-issue";
}
interface CliGrade {
  case: string;
  defect: number;
  matched: boolean;
}

function loadGolden(manifestPath: string): GoldenCase[] {
  return (
    parseYaml(readFileSync(manifestPath, "utf8")) as { cases: GoldenCase[] }
  ).cases;
}

function readKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [prov, file] of [
    ["openrouter", ".or_key"],
    ["zai", ".zai_key"],
  ]) {
    try {
      keys[prov] = readFileSync(join(homedir(), file), "utf8").trim();
    } catch {
      /* key absent */
    }
  }
  return keys;
}

/** Build the one user-turn prompt covering every has-issue case in a report: its defects + the reviewer's findings. */
function buildJudgePrompt(report: Report, golden: GoldenCase[]): string {
  const parts: string[] = [];
  for (const g of golden) {
    if (g.label !== "has-issue" || !g.expect_loci?.length) {
      continue;
    }
    const findings = report.results?.find((r) => r.id === g.id)?.findings ?? [];
    parts.push(`\n=== CASE ${g.id} ===`);
    parts.push("KNOWN DEFECTS (grade each):");
    g.expect_loci.forEach((l, i) => {
      parts.push(
        `  [${i}] file: ${l.path} — ${l.about}${l.evidence ? ` (evidence: ${l.evidence})` : ""}`
      );
    });
    parts.push("REVIEWER FINDINGS:");
    if (findings.length === 0) {
      parts.push("  (none — the reviewer reported no issues for this case)");
    }
    findings.forEach((f, i) => {
      parts.push(`  [${i}] ${f.path}:${f.line ?? "?"} — ${f.message}`);
    });
  }
  return parts.join("\n");
}

/** Pull the grades array out of a CLI model's reply text (tolerates fences / stray prose). */
function parseGrades(text: string): CliGrade[] | null {
  const m = text.match(GRADES_JSON_RE);
  if (!m) {
    return null;
  }
  try {
    return (JSON.parse(m[0]) as { grades?: CliGrade[] }).grades ?? null;
  } catch {
    return null;
  }
}

// ---- CLI vendor adapters: each shells its binary and returns the reply text (or null on failure) ----

function runClaude(
  model: string,
  effort: string,
  sys: string,
  user: string
): string | null {
  const args = ["-p", "--safe-mode", "--tools", "", "--output-format", "json"];
  if (model) {
    args.push("--model", model);
  }
  args.push("--append-system-prompt", sys);
  if (effort) {
    args.push("--effort", effort);
  }
  const { ANTHROPIC_BASE_URL: _drop, ...base } = process.env;
  const env = effort ? base : { ...base, MAX_THINKING_TOKENS: "0" };
  let raw: string;
  try {
    raw = execFileSync("claude", args, {
      encoding: "utf8",
      env,
      input: user,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (e) {
    raw = (e as { stdout?: string }).stdout ?? "";
  }
  try {
    const j = JSON.parse(raw) as { is_error?: boolean; result?: string };
    if (j.is_error) {
      return null;
    }
    return (j.result ?? raw).trim();
  } catch {
    return raw.trim();
  }
}

/** codex/grok/agy have no system-prompt flag — the contract is prepended to the prompt. */
function combinedPrompt(sys: string, user: string): string {
  return `${sys}\n\n${user}`;
}

function runCodex(
  model: string,
  effort: string,
  sys: string,
  user: string
): string | null {
  const dir = mkdtempSync(join(tmpdir(), "sqw-judge-codex-"));
  const outFile = join(dir, "out.txt");
  const args = [
    "exec",
    "-m",
    model,
    "-c",
    `model_reasoning_effort=${effort || "none"}`,
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    dir,
    "-o",
    outFile,
    combinedPrompt(sys, user),
  ];
  try {
    execFileSync("codex", args, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch {
    /* codex can exit non-zero yet still write the output file */
  }
  try {
    return readFileSync(outFile, "utf8").trim();
  } catch {
    return null;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function runGrok(
  model: string,
  effort: string,
  sys: string,
  user: string
): string | null {
  const dir = mkdtempSync(join(tmpdir(), "sqw-judge-grok-"));
  const args = [
    "--cwd",
    dir,
    "-m",
    model,
    ...(effort ? ["--effort", effort] : []),
    "--output-format",
    "json",
    "-p",
    combinedPrompt(sys, user), // must be last
  ];
  try {
    const raw = execFileSync("grok", args, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    const j = JSON.parse(raw) as { stopReason?: string; text?: string };
    if (j.stopReason && j.stopReason !== "EndTurn") {
      return null;
    }
    return (j.text ?? "").trim();
  } catch {
    return null;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function runAgy(
  model: string,
  _effort: string,
  sys: string,
  user: string
): string | null {
  const dir = mkdtempSync(join(tmpdir(), "sqw-judge-agy-"));
  const args = [
    "--add-dir",
    dir,
    "--model",
    model, // agy bakes effort into the model name
    "--print-timeout",
    "4m",
    "-p",
    combinedPrompt(sys, user),
  ];
  try {
    return execFileSync("agy", args, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    }).trim();
  } catch (e) {
    const salvaged = (e as { stdout?: string }).stdout ?? "";
    return salvaged.trim() || null;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

const CLI_ADAPTERS: Record<
  CliVendor,
  (model: string, effort: string, sys: string, user: string) => string | null
> = { agy: runAgy, claude: runClaude, codex: runCodex, grok: runGrok };

/** CLI path: one call for the whole report → parsed grades (null on failure). */
function judgeReportCli(
  vendor: CliVendor,
  model: string,
  effort: string,
  report: Report,
  golden: GoldenCase[]
): CliGrade[] | null {
  const user = buildJudgePrompt(report, golden);
  const sys = GRADING_CONTRACT + OUTPUT_INSTRUCTION;
  const text = CLI_ADAPTERS[vendor](model, effort, sys, user);
  return text ? parseGrades(text) : null;
}

/** API path: per-case createJudge (Pi registry + submit_grades tool), mapped to the shared CliGrade shape. */
async function judgeReportApi(
  lane: ModelLane,
  report: Report,
  golden: GoldenCase[],
  keys: Record<string, string>
): Promise<CliGrade[] | null> {
  const judge = createJudge({ apiKeys: keys });
  const out: CliGrade[] = [];
  let anyGraded = false;
  for (const g of golden) {
    if (g.label !== "has-issue" || !g.expect_loci?.length) {
      continue;
    }
    const findings = report.results?.find((r) => r.id === g.id)?.findings ?? [];
    // biome-ignore lint/performance/noAwaitInLoops: sequential — one judge call per case, respects the model's concurrency
    const { grades, graded } = await judge.judge(g.expect_loci, findings, lane);
    if (graded) {
      anyGraded = true;
    }
    for (const gr of grades) {
      out.push({ case: g.id, defect: gr.defectIndex, matched: gr.matched });
    }
  }
  return anyGraded ? out : null;
}

/** Score one report: file-level (sameFile) vs defect-level (judge), with the defect⊆file guard, per has-issue case. */
function scoreReport(
  report: Report,
  golden: GoldenCase[],
  grades: CliGrade[]
): { defect: number; file: number } {
  const byCase = new Map<string, CliGrade[]>();
  for (const gr of grades) {
    const list = byCase.get(gr.case) ?? [];
    list.push(gr);
    byCase.set(gr.case, list);
  }
  let file = 0;
  let defect = 0;
  for (const g of golden) {
    if (g.label !== "has-issue" || !g.expect_loci?.length) {
      continue;
    }
    const findings = report.results?.find((r) => r.id === g.id)?.findings ?? [];
    g.expect_loci.forEach((l, i) => {
      const onFile = findings.some((f) => sameFile(f.path, l.path));
      if (onFile) {
        file += 1;
      }
      const judged =
        (byCase.get(g.id) ?? []).find((cg) => cg.defect === i)?.matched ===
        true;
      if (judged && onFile) {
        defect += 1; // defect⊆file guard: only credit a defect when a finding is on its file
      }
    });
  }
  return { defect, file };
}

function resolveVendor(): Vendor {
  const v = (arg("vendor") ?? arg("cli") ?? "claude") as Vendor;
  if (![...CLI_VENDORS, ...API_VENDORS].includes(v)) {
    throw new Error(
      `unknown --vendor "${v}". choose: ${[...CLI_VENDORS, ...API_VENDORS].join(", ")}`
    );
  }
  return v;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a linear vendor-dispatch over a report×repeat loop with inline ungraded-exclusion + interval aggregation, not real branching complexity
async function main(): Promise<void> {
  const vendor = resolveVendor();
  const model = arg("model") ?? DEFAULT_MODEL[vendor];
  const effort = arg("effort") ?? "low"; // maintainer default: low effort, any model
  const repeats = Number(arg("repeats") ?? "1");
  const manifestPath = arg("manifest") ?? `${ROOT}eval/golden/manifest.yaml`;
  const reportPaths = (arg("reports") ?? arg("report") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (reportPaths.length === 0) {
    console.error("give --report <file> or --reports a,b,c");
    process.exit(1);
  }
  const isApi = (API_VENDORS as readonly string[]).includes(vendor);
  if (isApi && !model.includes(":")) {
    throw new Error(
      `--vendor ${vendor} needs --model as provider:model (e.g. ${vendor}:deepseek-v3.2)`
    );
  }
  const golden = loadGolden(manifestPath);
  const totalLoci = golden
    .filter((g) => g.label === "has-issue")
    .reduce((s, g) => s + (g.expect_loci?.length ?? 0), 0);
  const keys = readKeys();
  const apiLane: ModelLane = isApi
    ? {
        id: "judge",
        model: model.slice(model.indexOf(":") + 1),
        provider: model.slice(0, model.indexOf(":")),
        thinking: (arg("judge-thinking") ?? "off") as ThinkingLevel,
      }
    : ({} as ModelLane);

  console.log(
    `\n▸ judge-cli  vendor=${vendor}${model ? `/${model}` : ""}@${isApi ? (apiLane.thinking ?? "off") : effort}  reports=${reportPaths.length}  repeats=${repeats}  loci=${totalLoci}\n`
  );

  const perReportDefect: number[] = [];
  let ungraded = 0;
  for (const rp of reportPaths) {
    const report = JSON.parse(readFileSync(rp, "utf8")) as Report;
    const defectRuns: number[] = [];
    let fileTotal = 0;
    for (let r = 0; r < repeats; r += 1) {
      let grades: CliGrade[] | null;
      if (isApi) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential — one rate-limited judge call at a time
        grades = await judgeReportApi(apiLane, report, golden, keys);
      } else {
        grades = judgeReportCli(
          vendor as CliVendor,
          model,
          effort,
          report,
          golden
        );
      }
      if (grades === null) {
        ungraded += 1;
        console.log(
          `  ${rp.split("/").pop()}  run ${r + 1}: UNGRADED (failure) — excluded`
        );
        continue;
      }
      const s = scoreReport(report, golden, grades);
      fileTotal = s.file;
      defectRuns.push(s.defect);
    }
    const sortedRuns = [...defectRuns].sort((a, b) => a - b);
    const median = sortedRuns.length
      ? sortedRuns[Math.floor(sortedRuns.length / 2)]
      : undefined;
    console.log(
      `  ${(rp.split("/").pop() ?? rp).padEnd(48)} file=${fileTotal}/${totalLoci}  defect=[${defectRuns.join(",")}]${median === undefined ? " (all ungraded)" : ` median ${median}/${totalLoci}`}`
    );
    if (median !== undefined) {
      perReportDefect.push(median);
    }
  }

  if (perReportDefect.length > 0) {
    const s = [...perReportDefect].sort((a, b) => a - b);
    console.log(
      `\n  DEFECT recall across ${perReportDefect.length} report(s): ${s[0]}–${s.at(-1)} (median ${s[Math.floor(s.length / 2)]}) / ${totalLoci}`
    );
  }
  if (ungraded > 0) {
    console.log(
      `  ⚠ ${ungraded} run(s) ungraded (failure) — excluded, not scored 0`
    );
  }
  console.log("");
}

main();
