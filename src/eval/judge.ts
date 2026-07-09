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
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ModelLane } from "../core/types.js";

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
  grades: Grade[];
  usage: { input: number; output: number };
}

function sumUsage(messages: unknown[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const m of messages as Array<{
    usage?: { input?: number; output?: number };
  }>) {
    input += m.usage?.input ?? 0;
    output += m.usage?.output ?? 0;
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
      const modelRegistry = ModelRegistry.create(authStorage);
      const model = modelRegistry.find(lane.provider, lane.model);
      if (!model) {
        throw new Error(
          `Judge model not found: ${lane.provider}/${lane.model}`
        );
      }

      let captured: { grades: Grade[] } | undefined;
      const submitGrades = defineTool({
        description: "Submit the per-defect grades. Call exactly once.",
        execute: (_id, params) => {
          captured = params as { grades: Grade[] };
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
      const grades =
        // biome-ignore lint/suspicious/noUnnecessaryConditions: runtime guard — the model may still not have called submit_grades after the nudge loop exhausts its retries; Biome's flow analysis can't see that the while loop can exit with `captured` still undefined
        captured?.grades ??
        loci.map((_, i) => ({
          defectIndex: i,
          matched: false,
          why: "judge produced no grade",
        }));
      return { grades, usage };
    },
  };
}
