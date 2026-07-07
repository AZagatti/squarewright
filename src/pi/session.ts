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

/**
 * Read-only access to the repository at the PR's revision, so the Worker can GROUND findings against real
 * code (check surrounding code, callers, definitions) instead of guessing from the diff. The caller supplies
 * it: the eval fetches from GitHub at the head SHA; the real CI review reads from the checkout.
 */
export interface RepoReader {
  readFile(path: string): Promise<string | null>;
  listDir(path: string): Promise<string[] | null>;
}

export interface WorkerRequest {
  context: ReviewContext;
  /** the persona/system prompt that defines the review lens */
  systemPrompt: string;
  /** persona id, stamped onto findings for provenance/feedback */
  persona?: string;
  lane: ModelLane;
  /** read-only repo access for grounding; when present the Worker gets read_repo_file/list_repo_dir tools */
  repoReader?: RepoReader;
  /** extra custom tools to expose to the Worker (registered into Pi via defineTool) */
  tools?: WorkerTool[];
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
  usage?: {
    toolCalls: number;
    costUsd?: number;
    ms?: number;
    summary?: string;
    /**
     * Did the model actually call submit_findings? If false, `findings` is empty because the model never
     * submitted (NOT because the change is clean) — the caller must not treat that as a clean review.
     */
    submitted: boolean;
    /** billable tokens per pass — for the eval's immediate (lag-free) local spend guard */
    analysisTokens?: { input: number; output: number };
    structTokens?: { input: number; output: number };
  };
}

/** The one call the assembly makes into Pi. Implemented in v0.1 against `@earendil-works/pi-coding-agent`. */
export interface PiWorker {
  run(request: WorkerRequest): Promise<WorkerResult>;
}
