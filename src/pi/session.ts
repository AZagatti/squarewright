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
  listDir: (path: string) => Promise<string[] | null>;
  readFile: (path: string) => Promise<string | null>;
}

export interface WorkerRequest {
  budget?: { maxToolCalls?: number; maxTokens?: number };
  context: ReviewContext;
  /**
   * Enable the prompted CoT scaffold (recall + precision lever, 2026-07-12): forces an explain → find →
   * self-critique sequence in the analysis prompt. Distinct from native reasoning tokens (which don't help a
   * classification-shaped task like review). Opt-in + measured via `--scaffold`.
   */
  cotScaffold?: boolean;
  lane: ModelLane;
  /** persona id, stamped onto findings for provenance/feedback */
  persona?: string;
  /**
   * Enable rule-drift proposals (ADR-0005 §2): when true, the analysis pass MAY attach one ready-to-paste
   * `.review-rules` block to a finding (`proposedRule`) for an undocumented recurring pattern / stale rule. The
   * assembly turns this on only when the repo has adopted the rules/docs system, so drift-noise never reaches
   * repos that opted out. When false/undefined BOTH passes omit rule-drift entirely — Pass 1 drops the
   * instruction and Pass 2's structurer prompt + schema drop the `proposedRule` field — so it is a pure no-op,
   * not merely an unprompted-but-still-extractable path. The Worker also caps proposals at one per pass
   * (`capRuleDrift`).
   */
  proposeRuleDrift?: boolean;
  /** read-only repo access for grounding; when present the Worker gets read_repo_file/list_repo_dir tools */
  repoReader?: RepoReader;
  /**
   * Enable the SURVEYOR coverage pass (recall lever, #45): when true, the analysis prompt instructs the model to,
   * before finishing, re-scan EVERY other changed file/hunk for the same root cause as each issue it found and
   * report the recurrences — a same-call forced enumeration (not a second pass; a separate re-check call is a
   * proven no-op). Targets the enumeration miss-class where the same bug recurs across sibling files and is found
   * once but not everywhere. Opt-in + measured so its recall gain and any precision cost are visible.
   */
  surveyor?: boolean;
  /** the persona/system prompt that defines the review lens */
  systemPrompt: string;
  /** extra custom tools to expose to the Worker (registered into Pi via defineTool) */
  tools?: WorkerTool[];
}

export interface WorkerTool {
  description: string;
  execute: (args: unknown) => Promise<{ content: string; details?: unknown }>;
  name: string;
  /** JSON-schema-ish parameter spec; adapted to Pi's TypeBox tool contract at the boundary */
  parameters: Record<string, unknown>;
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
  run: (request: WorkerRequest) => Promise<WorkerResult>;
}
