/**
 * The Pi-backed Worker: drives one persona over a change and returns structured findings.
 *
 * Structured output strategy: instead of parsing freeform JSON out of prose, we give the agent a single
 * `submit_findings` tool with a typed schema. The model calls it once with its findings; we capture the
 * validated arguments directly. No salvage parser needed.
 *
 * This is the v0.1 keystone (ADR-0001) — everything else in the assembly feeds off it.
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
import type { PiWorker, WorkerRequest, WorkerResult } from "./session.js";

const findingsSchema = Type.Object({
  summary: Type.String({ description: "One or two sentences: the overall verdict on this change." }),
  findings: Type.Array(
    Type.Object({
      path: Type.String({ description: "Repo-relative file path (new side)." }),
      line: Type.Integer({ description: "1-indexed line on the new side the finding applies to." }),
      severity: Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]),
      title: Type.String({ description: "Short one-line summary of the issue." }),
      detail: Type.String({ description: "Why it matters, grounded in the diff. No speculation." }),
      suggestion: Type.Optional(
        Type.String({ description: "Exact single-line replacement, ONLY for mechanical one-line fixes." }),
      ),
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

/** Render the ReviewContext into the user prompt the Worker reasons over. */
function renderPrompt(ctx: ReviewContext): string {
  const parts: string[] = [
    `Review this pull request. Report only real issues in the changed lines; ground every finding in the diff.`,
    `\nPR #${ctx.prNumber} — ${ctx.title}`,
  ];
  if (ctx.body?.trim()) parts.push(`\nDescription:\n${ctx.body.trim()}`);
  parts.push(`\nUnified diff:\n`);
  for (const f of ctx.files) {
    if (!f.patch) continue;
    parts.push(`\n--- ${f.path} (${f.status}) ---\n${f.patch}`);
  }
  parts.push(
    `\nWhen done, call the \`submit_findings\` tool exactly once with your findings (empty array if the change is clean). Do not reply in prose.`,
  );
  return parts.join("\n");
}

export interface PiWorkerOptions {
  /** provider -> api key, injected at runtime (never persisted) */
  apiKeys: Record<string, string>;
}

export function createPiWorker(options: PiWorkerOptions): PiWorker {
  return {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      const lane: ModelLane = request.lane;

      const authStorage = AuthStorage.create();
      for (const [provider, key] of Object.entries(options.apiKeys)) {
        authStorage.setRuntimeApiKey(provider, key);
      }
      const modelRegistry = ModelRegistry.create(authStorage);

      const model = modelRegistry.find(lane.provider, lane.model);
      if (!model) {
        throw new Error(
          `Model not found in Pi's catalog: ${lane.provider}/${lane.model}. Check the provider/model id.`,
        );
      }

      let captured: { summary: string; findings: SubmittedFinding[] } | undefined;
      const submitFindings = defineTool({
        name: "submit_findings",
        label: "Submit findings",
        description: "Submit the final review findings. Call exactly once, then stop.",
        parameters: findingsSchema,
        execute: async (_toolCallId, params) => {
          captured = params as { summary: string; findings: SubmittedFinding[] };
          return {
            content: [{ type: "text", text: `Recorded ${captured.findings.length} finding(s).` }],
            details: {},
          };
        },
      });

      const loader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        systemPromptOverride: () => request.systemPrompt,
      });
      await loader.reload();

      const { session } = await createAgentSession({
        model,
        authStorage,
        modelRegistry,
        resourceLoader: loader,
        customTools: [submitFindings],
        noTools: "builtin", // no read/bash/edit/write — this spike is diff-only
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 2 },
        }),
      });

      let toolCalls = 0;
      session.subscribe((event) => {
        if (event.type === "tool_execution_start") toolCalls += 1;
      });

      await session.prompt(renderPrompt(request.context));

      // sum cost from assistant messages
      let costUsd = 0;
      for (const m of session.messages) {
        const usage = (m as { usage?: { cost?: { total?: number } } }).usage;
        if (usage?.cost?.total) costUsd += usage.cost.total;
      }
      session.dispose();

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
        usage: { toolCalls, costUsd, summary: captured?.summary },
      };
    },
  };
}
