/**
 * Defect-match judge. The file-level locus metric can't tell a finding that nails the real bug from one that
 * merely lands on the right file. This judge reads the case's ground-truth defect (about + evidence) and the
 * reviewer's findings, and decides — per defect — whether ANY finding actually identifies the same root cause.
 *
 * Runs as a single, reliable, thinking-off call (with a nudge) — no reasoning, so it won't drop the tool call.
 */
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ModelLane } from "../core/types.js";
import { createModelRegistry } from "../pi/model-catalog.js";

export interface DefectLocus {
  about: string;
  evidence?: string;
  path: string;
}
export interface JudgedFinding {
  line: number;
  message: string;
  path: string;
}
export interface Grade {
  defectIndex: number;
  findingIndex?: number;
  matched: boolean;
  why: string;
}

/** One judge call's grades plus the token usage it billed, so a paid judge run can be spend-capped. */
export interface JudgeResult {
  /** did the model actually call submit_grades? false ⇒ grades are the all-miss fallback, not a real judgment */
  graded: boolean;
  grades: Grade[];
  usage: { input: number; output: number };
}

/**
 * A warning when a judge silently failed to call submit_grades on some calls. Those calls fall back to
 * all-miss grades, so a recall of "0" can mean "the judge is broken," not "nothing matched" — the exact
 * honesty trap in AGENTS.md §5. Free OpenRouter models notably fail this thinking-off (qwen/llama returned
 * 0-across-the-board where glm-5.2 judged 6). Returns null when every call was genuinely graded.
 */
export function ungradedWarning(
  ungraded: number,
  calls: number
): string | null {
  if (ungraded <= 0) {
    return null;
  }
  return `⚠️  judge did not call submit_grades on ${ungraded}/${calls} calls (those counted as 0 matches). This judge is unreliable thinking-off — treat its recall as suspect. Free OpenRouter models fail this; use zai:glm-5.2 or a paid non-GLM (e.g. deepseek/deepseek-v3.2).`;
}

/**
 * A LOUD warning when the judge violated the structural invariant defect-matches ⊆ file-hits on some passes
 * (see the check in scripts/judge.ts). Such a pass is excluded from the recall interval and the caller exits
 * non-zero, because a judge that claims a root-cause match on a locus whose file was never flagged is
 * hallucinating — a failure mode we hit with a weak deepseek-v4-flash judge earlier in this project (its
 * defect count came out above the report's file-hit count, which is impossible). `evaluated` is the number of
 * invariant-checked (non-aborted) passes, so `hallucinated/evaluated` is always a real ≤1 ratio. Returns the
 * banner; callers gate on `hallucinated > 0` themselves.
 */
export function hallucinationWarning(
  hallucinated: number,
  evaluated: number
): string {
  return `🛑 JUDGE UNRELIABLE: ${hallucinated}/${evaluated} judged pass(es) scored defect > file (impossible — defect ⊆ file), so the judge hallucinated matches. Those passes were EXCLUDED from the recall interval and this run exits non-zero. Do NOT record these numbers; re-run with a different-family judge (e.g. zai:glm-5.2 or deepseek/deepseek-v3.2).`;
}

/** One case whose judge-assigned defect count exceeds its file-hit count — an impossible score. */
export interface DefectFileViolation {
  defect: number;
  file: number;
  id: string;
}

/**
 * The structural invariant: a locus can be defect-matched only if some finding lands on its file, so per case
 * `defectMatches ≤ fileHits`. A judge that returns more defect matches than file hits is hallucinating a
 * root-cause match onto a locus whose file was never flagged — a failure mode observed with a weak
 * deepseek-v4-flash judge in this project. Returns every violating case so the caller can flag it, exclude the
 * pass, and fail non-zero — pure so it's testable without any model call.
 */
export function defectFileViolations(
  cases: Array<{ defect: number; file: number; id: string }>
): DefectFileViolation[] {
  return cases
    .filter((c) => c.defect > c.file)
    .map((c) => ({ defect: c.defect, file: c.file, id: c.id }));
}

/**
 * The MIRROR of the hallucination guard: a systematically UNDER-permissive judge. A pass that scores ZERO defect
 * matches while findings landed on ≥2 loci's files is suspect — it calls submit_grades (so `ungradedWarning` misses
 * it) and never violates defect⊆file (so `defectFileViolations` misses it), yet it graded real matches as misses
 * and its recall is spuriously 0. Observed with kimi-k2.6 on golden (0/11 across arms that glm-5.2/deepseek-v3.2
 * scored 2–6). Pure so it's testable without a model call. `file` is per-case fileHits, `defect` the judge's matches.
 */
export function harshJudgeSuspect(
  cases: Array<{ defect: number; file: number }>
): boolean {
  const totalDefect = cases.reduce((s, c) => s + c.defect, 0);
  const casesWithFileHits = cases.filter((c) => c.file > 0).length;
  return totalDefect === 0 && casesWithFileHits >= 2;
}

/** Warning for suspect-harsh passes — the under-permissive mirror of `hallucinationWarning`. */
export function harshJudgeWarning(suspect: number, evaluated: number): string {
  return `⚠️  SUSPECT-HARSH JUDGE: ${suspect}/${evaluated} pass(es) scored 0 defect matches while findings landed on ≥2 loci's files — a systematically under-permissive judge grades real matches as misses, passing both the tool-call and defect⊆file guards undetected, so its recall is spuriously 0. Treat this judge's DEFECT recall as unreliable (kimi-k2.6 does this on golden); cross-check with zai:glm-5.2 or a validated cross-family judge before recording any recall number.`;
}

/**
 * Sum billable tokens across a session's messages for the spend guard — mirrors `sumTokens` in
 * src/pi/worker.ts, including its `totalTokens - input` fallback for messages that report only a total. Feeds
 * a money-safety cap, so it stays byte-compatible with the worker's accounting.
 */
export function sumUsage(messages: unknown[]): {
  input: number;
  output: number;
} {
  let input = 0;
  let output = 0;
  for (const m of messages as Array<{
    usage?: { input?: number; output?: number; totalTokens?: number };
  }>) {
    const u = m.usage;
    if (!u) {
      continue;
    }
    input += u.input ?? 0;
    output += u.output ?? Math.max(0, (u.totalTokens ?? 0) - (u.input ?? 0));
  }
  return { input, output };
}

export interface RepeatStat {
  max: number;
  median: number;
  min: number;
  values: number[];
}

/**
 * Collapse repeated measurements of the same quantity into a min/median/max spread. The judge is
 * stochastic — re-scoring a byte-identical report gives different totals (RESULTS.md records 8 then 7) —
 * so a single judged pass is not a number. This turns K passes into an honest range.
 */
export function summarize(values: number[]): RepeatStat {
  if (values.length === 0) {
    return { max: 0, median: 0, min: 0, values };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // The `?? …` fallbacks are unreachable (the array is non-empty here) but keep strict indexed
  // access happy without non-null assertions.
  const hi = sorted[mid] ?? 0;
  const lo = sorted[mid - 1] ?? hi;
  const median = sorted.length % 2 === 0 ? (lo + hi) / 2 : hi;
  return { max: sorted.at(-1) ?? 0, median, min: sorted[0] ?? 0, values };
}

export interface MatrixStat {
  /** spread of per-report medians — variance attributable to the analysis (worker) runs */
  analysis: RepeatStat;
  /** spread of per-report (max−min) ranges — how much the judge alone wobbles within a fixed report */
  judge: RepeatStat;
  /** spread across every analysis-run × judge-pass cell — the config's honest recall interval */
  overall: RepeatStat;
}

/**
 * Decompose a matrix of `analysisRuns × judgePasses` defect-recall totals into its two variance sources, so a
 * config's recall is reported as an interval, not a point (issue #49 AC3). `matrix[a]` holds the K judge-pass
 * totals for analysis run `a`. Empty rows (a report whose passes were all cut short by the spend cap) are
 * dropped, not counted as a fabricated 0 — an un-judged report is absent from the interval, not a zero in it.
 */
export function summarizeMatrix(matrix: number[][]): MatrixStat {
  const rows = matrix.filter((row) => row.length > 0);
  const perReport = rows.map((row) => summarize(row));
  return {
    analysis: summarize(perReport.map((s) => s.median)),
    judge: summarize(perReport.map((s) => s.max - s.min)),
    overall: summarize(rows.flat()),
  };
}

const SYSTEM = `You grade a code reviewer against known ground-truth defects in a pull request. For each known
defect, decide whether ANY of the reviewer's findings correctly identifies the SAME underlying problem — same
root cause and location, not merely the same file or a superficial mention. Be strict: a finding that lands on
the right file but describes a different issue does NOT match. Call submit_grades exactly once.`;

const gradesSchema = Type.Object({
  grades: Type.Array(
    Type.Object({
      defectIndex: Type.Integer(),
      findingIndex: Type.Optional(Type.Integer()),
      matched: Type.Boolean(),
      why: Type.String({
        description: "one sentence: why it matches or doesn't",
      }),
    })
  ),
});

function renderPrompt(loci: DefectLocus[], findings: JudgedFinding[]): string {
  const defects = loci
    .map(
      (l, i) =>
        `[${i}] file=${l.path} — ${l.about}${l.evidence ? `  (evidence: ${l.evidence})` : ""}`
    )
    .join("\n");
  const found =
    findings.length > 0
      ? findings
          .map((f, j) => `(${j}) ${f.path}:${f.line} — ${f.message}`)
          .join("\n")
      : "(the reviewer reported no findings)";
  return `KNOWN DEFECTS (ground truth):\n${defects}\n\nREVIEWER FINDINGS:\n${found}\n\nGrade each known defect: matched true/false, and findingIndex of the matching finding if any.`;
}

export function createJudge(opts: { apiKeys: Record<string, string> }) {
  return {
    async judge(
      loci: DefectLocus[],
      findings: JudgedFinding[],
      lane: ModelLane
    ): Promise<JudgeResult> {
      const authStorage = AuthStorage.create();
      for (const [p, k] of Object.entries(opts.apiKeys)) {
        authStorage.setRuntimeApiKey(p, k);
      }
      const modelRegistry = createModelRegistry(authStorage);
      const model = modelRegistry.find(lane.provider, lane.model);
      if (!model) {
        throw new Error(
          `Judge model not found: ${lane.provider}/${lane.model}`
        );
      }

      let captured: { grades: Grade[] } | undefined;
      let toolCalled = false;
      const submitGrades = defineTool({
        description: "Submit the per-defect grades. Call exactly once.",
        execute: (_id, params) => {
          captured = params as { grades: Grade[] };
          toolCalled = true;
          return Promise.resolve({
            content: [
              {
                text: `Graded ${captured.grades.length} defect(s).`,
                type: "text",
              },
            ],
            details: {},
          });
        },
        label: "Submit grades",
        name: "submit_grades",
        parameters: gradesSchema,
      });

      const loader = new DefaultResourceLoader({
        agentDir: getAgentDir(),
        cwd: process.cwd(),
        systemPromptOverride: () => SYSTEM,
      });
      await loader.reload();
      const { session } = await createAgentSession({
        authStorage,
        customTools: [submitGrades],
        model,
        modelRegistry,
        noTools: "builtin",
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 2 },
        }),
        thinkingLevel: "off",
      });
      await session.prompt(renderPrompt(loci, findings));
      let nudges = 0;
      while (captured === undefined && nudges < 2) {
        nudges += 1;
        // biome-ignore lint/performance/noAwaitInLoops: each nudge is only sent if the previous one failed to elicit submit_grades — inherently sequential/dependent
        await session.prompt(
          "Call submit_grades now, exactly once, with a grade for each known defect."
        );
      }
      const usage = sumUsage(session.messages);
      session.dispose();
      // `graded` = the model engaged the tool at all. A degenerate call with an empty grades array still
      // counts as graded — that's a different failure mode than AC2's "never called the tool" and is out of
      // this guard's scope.
      const grades =
        // biome-ignore lint/suspicious/noUnnecessaryConditions: runtime guard — the model may still not have called submit_grades after the nudge loop exhausts its retries; Biome's flow analysis can't see that the while loop can exit with `captured` still undefined
        captured?.grades ??
        loci.map((_, i) => ({
          defectIndex: i,
          matched: false,
          why: "judge produced no grade",
        }));
      return { graded: toolCalled, grades, usage };
    },
  };
}
