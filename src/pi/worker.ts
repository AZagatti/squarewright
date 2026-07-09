/**
 * The Pi-backed Worker: drives one persona over a change and returns structured findings — in TWO PASSES.
 *
 * Why two passes (ADR-0001 + the reasoning investigation):
 *   Forcing the model to reason AND emit a schema'd tool call in one shot is fragile — reasoning models
 *   frequently reason and then never call the tool (worse at higher effort: gpt-5-nano dropped 18/18 at
 *   `high`), which silently looks like a clean review. It also suppresses free-form reasoning ("the format tax").
 *   So we split:
 *     Pass 1 (analyze): the model under test, at its thinking level, reasons freely and writes its review as
 *       TEXT (+ optional repo grounding). Nothing to drop.
 *     Pass 2 (structure): a fixed, reliable, cheap extractor (no reasoning) turns that text into submit_findings.
 *   This is robust across models (fair for ranking), lets reasoning contribute, and can't silently drop.
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
import type {
  Finding,
  ModelLane,
  ReviewContext,
  Severity,
} from "../core/types.js";
import type {
  PiWorker,
  RepoReader,
  WorkerRequest,
  WorkerResult,
} from "./session.js";

/**
 * Fixed pass-2 extractor: no reasoning, reliably calls tools, cheap. Used when the config sets no structurer.
 * Defaults to z.ai's free glm-5-turbo so structuring never silently costs money — the structurer runs on every
 * pass of every review, so a paid default is a real cost footgun. (Assumes z.ai auth, consistent with the
 * default z.ai lanes; a config on another provider should point `structurer` at one of its own cheap models.)
 */
export const DEFAULT_STRUCTURER: ModelLane = {
  id: "structurer",
  model: "glm-5-turbo",
  provider: "zai",
  thinking: "off",
};

const ANALYSIS_NOTE = `

Write your review as prose. For every issue you find, state: the file path, the line number, a severity
(error / warning / info), and a grounded explanation of why it is a problem. If the change is sound, say
clearly that you found no issues. Do NOT output JSON — just your analysis.`;

const GROUNDING_NOTE = `

You can inspect the repository at this PR's revision with tools: read_repo_file(path) reads a file's full
contents, and list_repo_dir(path) lists a directory. BEFORE asserting an issue, use them to check the
surrounding code, callers, and definitions the diff doesn't show. Ground every claim in the real code — do
NOT flag something you have not verified against the actual files.

SCOPE — critical: use these tools ONLY to VERIFY issues that this PR's diff introduces or directly triggers.
Do NOT report pre-existing problems in code the PR did not change, missing hardening in files outside the
diff, or "this other file should also be fixed" observations — those are out of scope even when real. A
finding is valid only if this PR's changed lines cause it. If the change is sound, say so; do not go hunting
the wider repository for unrelated issues.`;

const STRUCTURER_SYSTEM = `You convert a code-review analysis into structured data. You are given one
reviewer's prose analysis of a pull request. Extract EVERY distinct issue it identifies — preserving the file
path, line number, severity, and explanation — and call submit_findings exactly once. If the analysis reports
no issues, call submit_findings with an empty findings array. Do not add issues the analysis didn't raise.`;

const findingsSchema = Type.Object({
  findings: Type.Array(
    Type.Object({
      detail: Type.String({
        description: "Why it matters, grounded in the diff/code.",
      }),
      line: Type.Integer({
        description: "1-indexed line on the new side the finding applies to.",
      }),
      path: Type.String({ description: "Repo-relative file path (new side)." }),
      severity: Type.Union([
        Type.Literal("error"),
        Type.Literal("warning"),
        Type.Literal("info"),
      ]),
      suggestion: Type.Optional(
        Type.String({
          description:
            "Exact single-line replacement, only for mechanical fixes.",
        })
      ),
      title: Type.String({
        description: "Short one-line summary of the issue.",
      }),
    })
  ),
  summary: Type.String({
    description: "One or two sentences: the overall verdict on this change.",
  }),
});

interface SubmittedFinding {
  detail: string;
  line: number;
  path: string;
  severity: Severity;
  suggestion?: string;
  title: string;
}

/** Read-only repo tools that let Pass 1 ground its analysis. */
function buildRepoTools(reader: RepoReader) {
  const readFile = defineTool({
    description:
      "Read the full contents of a file in the repository at the PR's revision, to check context.",
    execute: async (_id, params) => {
      const p = (params as { path: string }).path;
      const content = await reader.readFile(p);
      return {
        content: [{ text: content ?? `(file not found: ${p})`, type: "text" }],
        details: {},
      };
    },
    label: "Read repo file",
    name: "read_repo_file",
    parameters: Type.Object({
      path: Type.String({ description: "repo-relative file path" }),
    }),
  });
  const listDir = defineTool({
    description:
      "List the entries of a directory in the repository at the PR's revision.",
    execute: async (_id, params) => {
      const p = (params as { path: string }).path;
      const entries = await reader.listDir(p);
      return {
        content: [
          {
            text: entries ? entries.join("\n") : `(not a directory: ${p})`,
            type: "text",
          },
        ],
        details: {},
      };
    },
    label: "List repo dir",
    name: "list_repo_dir",
    parameters: Type.Object({
      path: Type.String({
        description: 'repo-relative directory path ("" for root)',
      }),
    }),
  });
  return [readFile, listDir];
}

/** The diff, rendered for the Pass-1 analysis prompt (no tool instruction — the model just reviews it). */
function renderAnalysisPrompt(ctx: ReviewContext): string {
  const parts: string[] = [
    "Review this pull request. Report only real issues in the changed lines; ground every claim in the code.",
    `\nPR #${ctx.prNumber} — ${ctx.title}`,
  ];
  if (ctx.body.trim()) {
    parts.push(`\nDescription:\n${ctx.body.trim()}`);
  }
  parts.push("\nUnified diff:\n");
  for (const f of ctx.files) {
    if (f.patch) {
      parts.push(`\n--- ${f.path} (${f.status}) ---\n${f.patch}`);
    }
  }
  return parts.join("\n");
}

function extractAssistantText(messages: unknown[]): string {
  const parts: string[] = [];
  for (const m of messages as Array<{ role?: string; content?: unknown }>) {
    if (m.role !== "assistant") {
      continue;
    }
    if (typeof m.content === "string") {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content as Array<{ type?: string; text?: string }>) {
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

function sumCost(messages: unknown[]): number {
  let c = 0;
  for (const m of messages as Array<{
    usage?: { cost?: { total?: number } };
  }>) {
    if (m.usage?.cost?.total) {
      c += m.usage.cost.total;
    }
  }
  return c;
}

/**
 * Sum billable tokens (output includes reasoning tokens — Pi's `usage.output` = `completion_tokens`, which per
 * OpenAI-compat already counts reasoning) for the eval's immediate, lag-free spend guard. It still counts only the
 * usage Pi reports for the FINAL attempt: throttle-driven retries re-send context and re-bill without being seen
 * here, so on a rate-limited provider the estimate can lag real spend. Bound OpenRouter reasoning cost with
 * `max_tokens` at the source too — see docs/reference/models-reasoning-and-cost.md.
 */
function sumTokens(messages: unknown[]): { input: number; output: number } {
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

export interface PiWorkerOptions {
  /** provider -> api key, injected at runtime (never persisted) */
  apiKeys: Record<string, string>;
  /** fixed pass-2 extractor lane (default: free z.ai glm-5-turbo, thinking off) */
  structurerLane?: ModelLane;
}

// retry.provider re-enables the openai-node SDK's own HTTP-level 429/5xx backoff, which Pi zeroes out by
// default (openai-completions.ts sets maxRetries:0). It reacts per-request and honors server-requested delay,
// which is the right layer for z.ai's undocumented concurrency throttle — the agent-level `retry` (fixed
// 2s/4s/8s, whole-turn restart) stays on as a coarse backstop. See docs/design/zai-reliability.md.
const SETTINGS = () =>
  SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: {
      enabled: true,
      maxRetries: 2,
      provider: { maxRetries: 4, maxRetryDelayMs: 20_000 },
    },
  });

export function createPiWorker(options: PiWorkerOptions): PiWorker {
  return {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      const authStorage = AuthStorage.create();
      for (const [provider, key] of Object.entries(options.apiKeys)) {
        authStorage.setRuntimeApiKey(provider, key);
      }
      const modelRegistry = ModelRegistry.create(authStorage);
      let toolCalls = 0;
      let costUsd = 0;

      // ── Pass 1: analyze (reason freely + optional grounding, output prose) ──
      const analysisModel = modelRegistry.find(
        request.lane.provider,
        request.lane.model
      );
      if (!analysisModel) {
        throw new Error(
          `Model not found in Pi's catalog: ${request.lane.provider}/${request.lane.model}.`
        );
      }
      const groundingTools = request.repoReader
        ? buildRepoTools(request.repoReader)
        : [];
      const analysisSystem =
        request.systemPrompt +
        (request.repoReader ? GROUNDING_NOTE : "") +
        ANALYSIS_NOTE;
      const loader1 = new DefaultResourceLoader({
        agentDir: getAgentDir(),
        cwd: process.cwd(),
        systemPromptOverride: () => analysisSystem,
      });
      await loader1.reload();
      const { session: s1 } = await createAgentSession({
        authStorage,
        customTools: groundingTools,
        model: analysisModel,
        modelRegistry,
        noTools: "builtin",
        resourceLoader: loader1,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SETTINGS(),
        thinkingLevel: request.lane.thinking ?? "off",
      });
      s1.subscribe((e) => {
        if (e.type === "tool_execution_start") {
          toolCalls += 1;
        }
      });
      await s1.prompt(renderAnalysisPrompt(request.context));
      const analysisText = extractAssistantText(s1.messages);
      costUsd += sumCost(s1.messages);
      const analysisTokens = sumTokens(s1.messages);
      s1.dispose();

      // ── Pass 2: structure (fixed reliable extractor, no reasoning) ──
      const structLane = options.structurerLane ?? DEFAULT_STRUCTURER;
      const structModel = modelRegistry.find(
        structLane.provider,
        structLane.model
      );
      if (!structModel) {
        throw new Error(
          `Structurer model not found: ${structLane.provider}/${structLane.model}.`
        );
      }
      let captured:
        | { summary: string; findings: SubmittedFinding[] }
        | undefined;
      const submitFindings = defineTool({
        description:
          "Submit the structured findings extracted from the analysis. Call exactly once.",
        execute: (_id, params) => {
          captured = params as {
            summary: string;
            findings: SubmittedFinding[];
          };
          return Promise.resolve({
            content: [
              {
                text: `Recorded ${captured.findings.length} finding(s).`,
                type: "text",
              },
            ],
            details: {},
          });
        },
        label: "Submit findings",
        name: "submit_findings",
        parameters: findingsSchema,
      });
      const loader2 = new DefaultResourceLoader({
        agentDir: getAgentDir(),
        cwd: process.cwd(),
        systemPromptOverride: () => STRUCTURER_SYSTEM,
      });
      await loader2.reload();
      const { session: s2 } = await createAgentSession({
        authStorage,
        customTools: [submitFindings],
        model: structModel,
        modelRegistry,
        noTools: "builtin",
        resourceLoader: loader2,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SETTINGS(),
        thinkingLevel: structLane.thinking ?? "off",
      });
      s2.subscribe((e) => {
        if (e.type === "tool_execution_start") {
          toolCalls += 1;
        }
      });
      const analysisForStructuring =
        analysisText.length > 0
          ? analysisText
          : "(the reviewer produced no analysis text)";
      await s2.prompt(
        "Extract the findings from this code-review analysis into submit_findings " +
          `(empty findings array if it reports no issues):\n\n${analysisForStructuring}`
      );
      let nudges = 0;
      while (captured === undefined && nudges < 2) {
        nudges += 1;
        // biome-ignore lint/performance/noAwaitInLoops: each nudge is only sent if the previous one failed to elicit submit_findings — inherently sequential/dependent
        await s2.prompt(
          "Call submit_findings now, exactly once, with the findings from the analysis (empty array if none)."
        );
      }
      costUsd += sumCost(s2.messages);
      const structTokens = sumTokens(s2.messages);
      s2.dispose();

      // biome-ignore lint/suspicious/noUnnecessaryConditions: runtime guard — the model may still not have called submit_findings after the nudge loop exhausts its retries; Biome's flow analysis can't see that the while loop can exit with `captured` still undefined
      const findings: Finding[] = (captured?.findings ?? []).map((f) => ({
        line: f.line,
        message: f.detail ? `${f.title} — ${f.detail}` : f.title,
        path: f.path,
        rule: request.persona ?? "persona:general",
        severity: f.severity,
        source: request.persona ?? "persona:general",
        suggestion: f.suggestion,
      }));

      return {
        findings,
        usage: {
          analysisTokens,
          costUsd,
          structTokens,
          submitted: captured !== undefined,
          summary: captured?.summary,
          toolCalls,
        },
      };
    },
  };
}
