/**
 * Thin seam over Pi (the borrowed agent runtime). Squarewright uses Pi as a *library* — `createAgentSession`
 * for the loop, `defineTool` to register our custom review tools (repo-inspect, ci-signal, post-comment),
 * and session fork/resume for @mention follow-ups and re-review on new commits.
 *
 * The harness lives in Pi's ecosystem (TypeScript) and uses it in-process — the reviewer's custom tools are
 * themselves Pi tools, so one ecosystem is both simpler and more capable (ADR-0001).
 *
 * v0.1 wiring lands with the review harness. This interface pins the boundary so the rest of the code can
 * be built and tested against it.
 */
import type { Finding, ModelLane, ReviewContext } from "../core/types.js";

export interface WorkerRequest {
  context: ReviewContext;
  /** the persona/system prompt that defines the review lens */
  systemPrompt: string;
  lane: ModelLane;
  /** custom tools to expose to the Worker (registered into Pi via defineTool) */
  tools: WorkerTool[];
  budget?: { maxToolCalls?: number; maxTokens?: number };
}

export interface WorkerTool {
  name: string;
  description: string;
  /** JSON-schema-ish parameter spec; adapted to Pi's TypeBox tool contract at the boundary */
  parameters: Record<string, unknown>;
  execute: (args: unknown) => Promise<{ content: string; details?: unknown }>;
}

export interface WorkerResult {
  findings: Finding[];
  /** cost/latency captured from Pi's transcript, for the feedback/data loop */
  usage?: { toolCalls: number; costUsd?: number; ms?: number };
}

/** The one call the assembly makes into Pi. Implemented in v0.1 against `@earendil-works/pi-coding-agent`. */
export interface PiWorker {
  run(request: WorkerRequest): Promise<WorkerResult>;
}
