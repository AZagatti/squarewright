/**
 * Adversarial Verifier: takes a candidate finding and tries to REFUTE it, empirically.
 *
 * Unlike the Worker, the Verifier gets a real shell (Pi's built-in `bash` tool) so it can *test* a claim
 * instead of just second-guessing it — e.g. run `node -e '...'` to check a JavaScript-semantics assertion.
 * This is the concrete answer to the spike's lesson: one diff-only model call ships confident false
 * positives; a step that actually runs code catches them.
 *
 * Safety note: the shell runs with the process's own permissions. In the real product this must be
 * sandboxed (Pi ships no sandbox — safety is Squarewright's to own). For the spike it runs locally.
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
import type { Finding, ModelLane, ReviewContext } from "../core/types.js";

const PERSONA = `You are a skeptical code-review verifier. Another reviewer produced the finding below, and it
may well be a false positive. Your job is to try to REFUTE it. You have a shell — USE IT to test claims
empirically whenever possible (for example, run \`node -e '...'\` to check a JavaScript-semantics claim, or
inspect real behavior). Only mark "confirmed" when you have concrete evidence the issue is real. If the claim
is demonstrably false, mark "refuted". If you genuinely cannot tell, mark "uncertain". Then call
submit_verdict exactly once.`;

const verdictSchema = Type.Object({
  verdict: Type.Union([Type.Literal("confirmed"), Type.Literal("refuted"), Type.Literal("uncertain")]),
  reasoning: Type.String({ description: "Why — cite the concrete evidence, especially any command output." }),
  evidence: Type.Optional(Type.String({ description: "Command(s) run and their output, if any." })),
});

export interface Verdict {
  verdict: "confirmed" | "refuted" | "uncertain";
  reasoning: string;
  evidence?: string;
  usage?: { toolCalls: number; costUsd?: number };
}

export interface VerifierOptions {
  apiKeys: Record<string, string>;
}

function renderPrompt(finding: Finding, ctx: ReviewContext): string {
  const diff = ctx.files.map((f) => (f.patch ? `--- ${f.path} ---\n${f.patch}` : "")).join("\n\n");
  return [
    `A reviewer flagged this finding on PR #${ctx.prNumber}:`,
    `\n  file: ${finding.path}:${finding.line}`,
    `  severity: ${finding.severity}`,
    `  claim: ${finding.message}`,
    finding.suggestion ? `  suggested fix: ${finding.suggestion}` : ``,
    `\nThe change under review (unified diff):\n\n${diff}`,
    `\nRefute or confirm the claim. Test it with the shell if you can. Then call submit_verdict once.`,
  ].join("\n");
}

export function createVerifier(options: VerifierOptions) {
  return {
    async verify(finding: Finding, ctx: ReviewContext, lane: ModelLane): Promise<Verdict> {
      const authStorage = AuthStorage.create();
      for (const [provider, key] of Object.entries(options.apiKeys)) {
        authStorage.setRuntimeApiKey(provider, key);
      }
      const modelRegistry = ModelRegistry.create(authStorage);
      const model = modelRegistry.find(lane.provider, lane.model);
      if (!model) throw new Error(`Model not found: ${lane.provider}/${lane.model}`);

      let captured: Omit<Verdict, "usage"> | undefined;
      const submitVerdict = defineTool({
        name: "submit_verdict",
        label: "Submit verdict",
        description: "Submit the final verdict on the finding. Call exactly once, then stop.",
        parameters: verdictSchema,
        execute: async (_id, params) => {
          captured = params as Omit<Verdict, "usage">;
          return { content: [{ type: "text", text: `Verdict: ${captured.verdict}` }], details: {} };
        },
      });

      const loader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        systemPromptOverride: () => PERSONA,
      });
      await loader.reload();

      const { session } = await createAgentSession({
        model,
        authStorage,
        modelRegistry,
        resourceLoader: loader,
        customTools: [submitVerdict],
        tools: ["bash", "submit_verdict"], // allow shell so it can test claims empirically
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 2 },
        }),
      });

      let toolCalls = 0;
      session.subscribe((e) => {
        if (e.type === "tool_execution_start") toolCalls += 1;
      });

      await session.prompt(renderPrompt(finding, ctx));

      let costUsd = 0;
      for (const m of session.messages) {
        const usage = (m as { usage?: { cost?: { total?: number } } }).usage;
        if (usage?.cost?.total) costUsd += usage.cost.total;
      }
      session.dispose();

      return {
        verdict: captured?.verdict ?? "uncertain",
        reasoning: captured?.reasoning ?? "(no verdict returned)",
        evidence: captured?.evidence,
        usage: { toolCalls, costUsd },
      };
    },
  };
}
