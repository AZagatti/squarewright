/**
 * Core domain types shared across the assembly. Kept deliberately small and stable —
 * these are the "studs" that Bricks snap onto (see docs/CONTEXT.md).
 */

export type Severity = "error" | "warning" | "info";

/** A single review result. Serializable; the canonical hand-off between Bricks. */
export interface Finding {
  /** repo-relative path (new side) */
  path: string;
  /** 1-indexed new-side line */
  line: number;
  severity: Severity;
  /** stable rule/persona id, e.g. "persona:security" or "grounder:breaking-change" */
  rule: string;
  message: string;
  /** why this is grounded — a fact, tool observation, or citation (optional) */
  evidence?: string;
  /** exact single-line replacement for a one-click GitHub suggestion (optional) */
  suggestion?: string;
  /** which persona(s)/tool produced it — provenance for feedback + dedup */
  source?: string;
}

/** A named (provider, model, reasoning) target a persona routes to. Mechanism is Pi's; policy is ours. */
export interface ModelLane {
  id: string;
  provider: string;
  model: string;
  /** provider-specific reasoning knob, passed through to Pi verbatim */
  reasoning?: Record<string, unknown>;
}

/** A review lens the Worker applies. */
export interface Persona {
  id: string;
  /** default model lane for this persona */
  lane: string;
  /** glob triggers; empty/"always" => runs on any reviewable change */
  when?: string[];
  /** skip on docs-only PRs */
  needsCode?: boolean;
  /** never paired with another persona in one Worker call */
  solo?: boolean;
  /** the checklist / role prompt injected into the Worker */
  prompt: string;
}

/** The PR under review, assembled in the (untrusted) gather phase and consumed in the (trusted) review phase. */
export interface ReviewContext {
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
  /** unified-diff per file + metadata (the only PR-derived input trusted as *data*, never executed) */
  files: ChangedFile[];
  /** CI check conclusions + annotations, consumed read-only as grounding */
  ciSignals?: CiSignal[];
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  patch?: string;
}

export interface CiSignal {
  check: string;
  conclusion: string;
  /** file:line-scoped annotations (already lint/test output), fed as grounding, never re-run */
  annotations?: { path: string; line: number; message: string }[];
}
