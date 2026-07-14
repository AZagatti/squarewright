/**
 * CLI defect-match judge — drives a SUBSCRIPTION CLI (default `claude -p`, the model behind the /claude-headless
 * skill) as the cross-family judge, instead of an API model through `scripts/judge.ts`. Why: the API judges are
 * unreliable here — free OpenRouter deepseek drops the `submit_grades` tool call (81/81 thinking-off), and the
 * flat-fee opencode Go-tier models (kimi-k2.6, deepseek-v4-pro) drop it too (an opencode-endpoint custom-tool
 * issue, not a reasoning one — measured 2026-07-14). A CLI judge sidesteps custom-tool-calling entirely: it asks
 * the model for STRICT JSON grades in its text reply and parses them, the same way the documented subagent judge
 * (docs/reference/subagent-judge.md) "returns the count in prose". `claude -p` grading a glm-5.2 report is genuinely
 * CROSS-FAMILY; reasoning is off/low (judge is classification, not generation — reasoning doesn't help, and low is
 * the goldilocks). No OpenRouter, no per-token spend (subscription).
 *
 * The exact grading contract is the one from src/eval/judge.ts's SYSTEM prompt; the strict same-root-cause-and-
 * location rule and the defect⊆file structural guard are reused so a CLI judge scores like the API judge.
 *
 *   bun run scripts/judge-cli.ts --report eval/reports/<file>.json [--cli claude] [--model claude-sonnet-5] [--effort low] [--repeats 3]
 *   bun run scripts/judge-cli.ts --reports "a.json,b.json" --repeats 3      (analysis×judge matrix)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { DefectLocus } from "../src/eval/judge.js";
import { sameFile } from "../src/eval/locus-match.js";

const ROOT = new URL("..", import.meta.url).pathname;
// The grades JSON object in the model's reply (may be fenced or wrapped in stray prose despite instructions).
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

function loadGolden(manifestPath: string): GoldenCase[] {
  return (
    parseYaml(readFileSync(manifestPath, "utf8")) as { cases: GoldenCase[] }
  ).cases;
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

interface CliGrade {
  case: string;
  defect: number;
  matched: boolean;
  why?: string;
}

/** Drive `claude -p` (or another subscription CLI) once; return parsed grades, or null on a failed/unparseable call. */
function cliJudge(
  cli: string,
  model: string | undefined,
  effort: string | undefined,
  userPrompt: string
): CliGrade[] | null {
  const system = GRADING_CONTRACT + OUTPUT_INSTRUCTION;
  // claude -p, mirroring scripts/eval-cli.ts: no tools (clean single-turn), JSON envelope, prompt via stdin.
  const args = ["-p", "--safe-mode", "--tools", "", "--output-format", "json"];
  if (model) {
    args.push("--model", model);
  }
  args.push("--append-system-prompt", system);
  if (effort) {
    args.push("--effort", effort);
  }
  // env hygiene: drop ANTHROPIC_BASE_URL; MAX_THINKING_TOKENS=0 = the real reasoning-off lane when no --effort given.
  const { ANTHROPIC_BASE_URL: _drop, ...baseEnv } = process.env;
  const env = effort ? baseEnv : { ...baseEnv, MAX_THINKING_TOKENS: "0" };
  let raw: string;
  try {
    raw = execFileSync(cli, args, {
      encoding: "utf8",
      env,
      input: userPrompt,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (e) {
    raw = (e as { stdout?: string }).stdout ?? "";
  }
  // claude --output-format json wraps the reply in {result, is_error}; other CLIs may print bare text.
  let text = raw.trim();
  try {
    const env2 = JSON.parse(raw) as { is_error?: boolean; result?: string };
    if (env2.is_error) {
      return null;
    }
    if (typeof env2.result === "string") {
      text = env2.result.trim();
    }
  } catch {
    /* not a JSON envelope — treat raw as the reply text */
  }
  // Extract the grades JSON object from the reply (may be fenced or have stray prose despite instructions).
  const m = text.match(GRADES_JSON_RE);
  if (!m) {
    return null;
  }
  try {
    const parsed = JSON.parse(m[0]) as { grades?: CliGrade[] };
    return parsed.grades ?? null;
  } catch {
    return null;
  }
}

interface CaseScore {
  defectRecall: number;
  fileRecall: number;
  graded: boolean;
  id: string;
  lociTotal: number;
}

/** Score one report: file-level (sameFile) vs defect-level (CLI judge), with the defect⊆file guard. */
function scoreReport(
  report: Report,
  golden: GoldenCase[],
  grades: CliGrade[] | null
): { cases: CaseScore[]; graded: boolean } {
  const graded = grades !== null;
  const byCase = new Map<string, CliGrade[]>();
  for (const gr of grades ?? []) {
    const list = byCase.get(gr.case) ?? [];
    list.push(gr);
    byCase.set(gr.case, list);
  }
  const cases: CaseScore[] = [];
  for (const g of golden) {
    if (g.label !== "has-issue" || !g.expect_loci?.length) {
      continue;
    }
    const findings = report.results?.find((r) => r.id === g.id)?.findings ?? [];
    const loci = g.expect_loci;
    const fileRecall = loci.filter((l) =>
      findings.some((f) => sameFile(f.path, l.path))
    ).length;
    // defect-level: a defect matches iff the judge said matched AND (structural guard) some finding is on its file.
    let defectRecall = 0;
    const caseGrades = byCase.get(g.id) ?? [];
    loci.forEach((l, i) => {
      const onFile = findings.some((f) => sameFile(f.path, l.path));
      const judged = caseGrades.find((cg) => cg.defect === i)?.matched === true;
      if (judged && onFile) {
        defectRecall += 1;
      }
    });
    cases.push({
      defectRecall,
      fileRecall,
      graded,
      id: g.id,
      lociTotal: loci.length,
    });
  }
  return { cases, graded };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a linear report × repeat judging loop with inline ungraded-exclusion + interval aggregation, not real branching complexity
function main(): void {
  const cli = arg("cli") ?? "claude";
  const model = arg("model"); // default: the CLI's own default model
  const effort = arg("effort"); // omit = reasoning-off (MAX_THINKING_TOKENS=0)
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
  const golden = loadGolden(manifestPath);
  const totalLoci = golden
    .filter((g) => g.label === "has-issue")
    .reduce((s, g) => s + (g.expect_loci?.length ?? 0), 0);

  console.log(
    `\n▸ judge-cli  cli=${cli}${model ? `/${model}` : ""}@${effort ?? "off"}  reports=${reportPaths.length}  repeats=${repeats}  loci=${totalLoci}\n`
  );

  const perReportDefect: number[] = [];
  let ungraded = 0;
  for (const rp of reportPaths) {
    const report = JSON.parse(readFileSync(rp, "utf8")) as Report;
    const prompt = buildJudgePrompt(report, golden);
    const defectRuns: number[] = [];
    let fileTotal = 0;
    for (let r = 0; r < repeats; r += 1) {
      const grades = cliJudge(cli, model, effort, prompt);
      if (grades === null) {
        ungraded += 1;
        console.log(
          `  ${rp.split("/").pop()}  run ${r + 1}: UNGRADED (CLI/parse failure) — excluded`
        );
        continue;
      }
      const { cases } = scoreReport(report, golden, grades);
      const defect = cases.reduce((s, c) => s + c.defectRecall, 0);
      fileTotal = cases.reduce((s, c) => s + c.fileRecall, 0);
      defectRuns.push(defect);
    }
    const median = defectRuns.length
      ? [...defectRuns].sort((a, b) => a - b)[Math.floor(defectRuns.length / 2)]
      : undefined;
    console.log(
      `  ${(rp.split("/").pop() ?? rp).padEnd(48)} file=${fileTotal}/${totalLoci}  defect=[${defectRuns.join(",")}]${median === undefined ? " (all ungraded)" : ` median ${median}/${totalLoci}`}`
    );
    if (median !== undefined) {
      perReportDefect.push(median);
    }
  }

  if (perReportDefect.length > 0) {
    const sorted = [...perReportDefect].sort((a, b) => a - b);
    console.log(
      `\n  DEFECT recall across ${perReportDefect.length} report(s): ${sorted[0]}–${sorted.at(-1)} (median ${sorted[Math.floor(sorted.length / 2)]}) / ${totalLoci}`
    );
  }
  if (ungraded > 0) {
    console.log(
      `  ⚠ ${ungraded} run(s) ungraded (CLI/parse failure) — excluded, not scored 0`
    );
  }
  console.log("");
}

main();
