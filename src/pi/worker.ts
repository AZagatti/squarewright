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
  defineTool,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Finding, ModelLane, ReviewContext, Severity } from "../core/types.js";
import type { PiWorker, RepoReader, WorkerRequest, WorkerResult } from "./session.js";

/** Fixed pass-2 extractor: no reasoning, reliably calls tools, cheap. */
const DEFAULT_STRUCTURER: ModelLane = {
  id: "structurer",
  provider: "openrouter",
  model: "qwen/qwen3-coder-30b-a3b-instruct",
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
  summary: Type.String({ description: "One or two sentences: the overall verdict on this change." }),
  findings: Type.Array(
    Type.Object({
      path: Type.String({ description: "Repo-relative file path (new side)." }),
      line: Type.Integer({ description: "1-indexed line on the new side the finding applies to." }),
      severity: Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]),
      title: Type.String({ description: "Short one-line summary of the issue." }),
      detail: Type.String({ description: "Why it matters, grounded in the diff/code." }),
      suggestion: Type.Optional(Type.String({ description: "Exact single-line replacement, only for mechanical fixes." })),
    }),
  ),
});

interface SubmittedFinding {
  path: string;
  line: number;
  severity: Severity;
  title: string;
  detail: string;
  suggestion?: string;
}

/** Read-only repo tools that let Pass 1 ground its analysis. */
function buildRepoTools(reader: RepoReader) {
  const readFile = defineTool({
    name: "read_repo_file",
    label: "Read repo file",
    description: "Read the full contents of a file in the repository at the PR's revision, to check context.",
    parameters: Type.Object({ path: Type.String({ description: "repo-relative file path" }) }),
    execute: async (_id, params) => {
      const p = (params as { path: string }).path;
      const content = await reader.readFile(p);
      return { content: [{ type: "text", text: content ?? `(file not found: ${p})` }], details: {} };
    },
  });
  const listDir = defineTool({
    name: "list_repo_dir",
    label: "List repo dir",
    description: "List the entries of a directory in the repository at the PR's revision.",
    parameters: Type.Object({ path: Type.String({ description: 'repo-relative directory path ("" for root)' }) }),
    execute: async (_id, params) => {
      const p = (params as { path: string }).path;
      const entries = await reader.listDir(p);
      return { content: [{ type: "text", text: entries ? entries.join("\n") : `(not a directory: ${p})` }], details: {} };
    },
  });
  return [readFile, listDir];
}

/** The diff, rendered for the Pass-1 analysis prompt (no tool instruction — the model just reviews it). */
function renderAnalysisPrompt(ctx: ReviewContext): string {
  const parts: string[] = [
    `Review this pull request. Report only real issues in the changed lines; ground every claim in the code.`,
    `\nPR #${ctx.prNumber} — ${ctx.title}`,
  ];
  if (ctx.body?.trim()) parts.push(`\nDescription:\n${ctx.body.trim()}`);
  parts.push(`\nUnified diff:\n`);
  for (const f of ctx.files) {
    if (f.patch) parts.push(`\n--- ${f.path} (${f.status}) ---\n${f.patch}`);
  }
  return parts.join("\n");
}

function extractAssistantText(messages: unknown[]): string {
  const parts: string[] = [];
  for (const m of messages as Array<{ role?: string; content?: unknown }>) {
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content as Array<{ type?: string; text?: string }>) {
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function sumCost(messages: unknown[]): number {
  let c = 0;
  for (const m of messages as Array<{ usage?: { cost?: { total?: number } } }>) {
    if (m.usage?.cost?.total) c += m.usage.cost.total;
  }
  return c;
}

/** Sum billable tokens (output includes reasoning tokens) — for the eval's immediate, lag-free spend guard. */
function sumTokens(messages: unknown[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const m of messages as Array<{ usage?: { input?: number; output?: number; totalTokens?: number } }>) {
    const u = m.usage;
    if (!u) continue;
    input += u.input ?? 0;
    output += u.output ?? Math.max(0, (u.totalTokens ?? 0) - (u.input ?? 0));
  }
  return { input, output };
}

export interface PiWorkerOptions {
  /** provider -> api key, injected at runtime (never persisted) */
  apiKeys: Record<string, string>;
  /** fixed pass-2 extractor lane (default: qwen3-coder-30b, thinking off) */
  structurerLane?: ModelLane;
}

// retry.provider re-enables the openai-node SDK's own HTTP-level 429/5xx backoff, which Pi zeroes out by
// default (openai-completions.ts sets maxRetries:0). It reacts per-request and honors server-requested delay,
// which is the right layer for z.ai's undocumented concurrency throttle — the agent-level `retry` (fixed
// 2s/4s/8s, whole-turn restart) stays on as a coarse backstop. See docs/design/zai-reliability.md.
const SETTINGS = () =>
  SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2, provider: { maxRetries: 4, maxRetryDelayMs: 20_000 } },
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
      const analysisModel = modelRegistry.find(request.lane.provider, request.lane.model);
      if (!analysisModel) {
        throw new Error(`Model not found in Pi's catalog: ${request.lane.provider}/${request.lane.model}.`);
      }
      const groundingTools = request.repoReader ? buildRepoTools(request.repoReader) : [];
      const analysisSystem = request.systemPrompt + (request.repoReader ? GROUNDING_NOTE : "") + ANALYSIS_NOTE;
      const loader1 = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        systemPromptOverride: () => analysisSystem,
      });
      await loader1.reload();
      const { session: s1 } = await createAgentSession({
        model: analysisModel,
        thinkingLevel: request.lane.thinking ?? "off",
        authStorage,
        modelRegistry,
        resourceLoader: loader1,
        customTools: groundingTools,
        noTools: "builtin",
        sessionManager: SessionManager.inMemory(),
        settingsManager: SETTINGS(),
      });
      s1.subscribe((e) => {
        if (e.type === "tool_execution_start") toolCalls += 1;
      });
      await s1.prompt(renderAnalysisPrompt(request.context));
      const analysisText = extractAssistantText(s1.messages);
      costUsd += sumCost(s1.messages);
      const analysisTokens = sumTokens(s1.messages);
      s1.dispose();

      // ── Pass 2: structure (fixed reliable extractor, no reasoning) ──
      const structLane = options.structurerLane ?? DEFAULT_STRUCTURER;
      const structModel = modelRegistry.find(structLane.provider, structLane.model);
      if (!structModel) {
        throw new Error(`Structurer model not found: ${structLane.provider}/${structLane.model}.`);
      }
      let captured: { summary: string; findings: SubmittedFinding[] } | undefined;
      const submitFindings = defineTool({
        name: "submit_findings",
        label: "Submit findings",
        description: "Submit the structured findings extracted from the analysis. Call exactly once.",
        parameters: findingsSchema,
        execute: async (_id, params) => {
          captured = params as { summary: string; findings: SubmittedFinding[] };
          return { content: [{ type: "text", text: `Recorded ${captured.findings.length} finding(s).` }], details: {} };
        },
      });
      const loader2 = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        systemPromptOverride: () => STRUCTURER_SYSTEM,
      });
      await loader2.reload();
      const { session: s2 } = await createAgentSession({
        model: structModel,
        thinkingLevel: structLane.thinking ?? "off",
        authStorage,
        modelRegistry,
        resourceLoader: loader2,
        customTools: [submitFindings],
        noTools: "builtin",
        sessionManager: SessionManager.inMemory(),
        settingsManager: SETTINGS(),
      });
      s2.subscribe((e) => {
        if (e.type === "tool_execution_start") toolCalls += 1;
      });
      const analysisForStructuring = analysisText.length > 0 ? analysisText : "(the reviewer produced no analysis text)";
      await s2.prompt(
        `Extract the findings from this code-review analysis into submit_findings ` +
          `(empty findings array if it reports no issues):\n\n${analysisForStructuring}`,
      );
      let nudges = 0;
      while (captured === undefined && nudges < 2) {
        nudges++;
        await s2.prompt("Call submit_findings now, exactly once, with the findings from the analysis (empty array if none).");
      }
      costUsd += sumCost(s2.messages);
      const structTokens = sumTokens(s2.messages);
      s2.dispose();

      const findings: Finding[] = (captured?.findings ?? []).map((f) => ({
        path: f.path,
        line: f.line,
        severity: f.severity,
        rule: request.persona ?? "persona:general",
        message: f.detail ? `${f.title} — ${f.detail}` : f.title,
        suggestion: f.suggestion,
        source: request.persona ?? "persona:general",
      }));

      return {
        findings,
        usage: {
          toolCalls,
          costUsd,
          summary: captured?.summary,
          submitted: captured !== undefined,
          analysisTokens,
          structTokens,
        },
      };
    },
  };
}
