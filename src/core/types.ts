/**
 * Core domain types shared across the assembly. Kept deliberately small and stable —
 * these are the "studs" that Bricks snap onto (see docs/CONTEXT.md).
 */

export type Severity = "error" | "warning" | "info";

/** A single review result. Serializable; the canonical hand-off between Bricks. */
export interface Finding {
  /** why this is grounded — a fact, tool observation, or citation (optional) */
  evidence?: string;
  /** 1-indexed new-side line */
  line: number;
  message: string;
  /** repo-relative path (new side) */
  path: string;
  /**
   * Rule-drift proposal (ADR-0005 §2): a ready-to-paste `.review-rules/*.md` block a human adds to make an
   * undocumented pattern a project rule. When set, the finding renders as a 📖 rule-drift proposal (a suggestion
   * a human acts on — never an auto-write). The reviewer proposes; the human edits the rule file.
   */
  proposedRule?: string;
  /** stable rule/persona id, e.g. "persona:security" or "grounder:breaking-change" */
  rule: string;
  severity: Severity;
  /** which persona(s)/tool produced it — provenance for feedback + dedup */
  source?: string;
  /** exact single-line replacement for a one-click GitHub suggestion (optional) */
  suggestion?: string;
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

/** A named (provider, model, reasoning) target a persona routes to. Mechanism is Pi's; policy is ours. */
export interface ModelLane {
  id: string;
  model: string;
  provider: string;
  /** reasoning/thinking level; Pi maps it to the provider's knob (e.g. OpenRouter reasoning effort) */
  thinking?: ThinkingLevel;
}

/** A review lens the Worker applies. */
export interface Persona {
  /**
   * Marks the AC-conformance auditor. Such a persona is NOT glob/file-routed (see `selectPersonasWithDrops`,
   * which excludes it): it runs as its own dedicated pass ONLY when the PR closes an issue that was fetched into
   * `ReviewContext.linkedIssue`, with the Worker's `acCheck` mode on. Kept a separate pass so the untrusted issue
   * text never enters the defect personas' context. Best given a strong `lane` (eval/RESULTS.md 2026-07-13).
   */
  acCheck?: boolean;
  id: string;
  /** friendly name shown to users for attribution (e.g. "Security"); defaults to `id` when unset */
  label?: string;
  /** default model lane for this persona (label; the concrete model is resolved by the assembly) */
  lane: string;
  /** skip on docs-only PRs */
  needsCode?: boolean;
  /**
   * Explicit pass-group key: personas sharing a `pass` are batched into ONE Worker call whenever they
   * co-fire on a PR (correlated-lens review — e.g. Docker + CI changes reviewed together). Takes precedence
   * over `solo`. Unset => the persona groups by `solo` (own pass) or into the shared "baseline" batch.
   */
  pass?: string;
  /** the checklist / role prompt injected into the Worker */
  prompt: string;
  /** never paired with another persona in one Worker call (own dedicated call) */
  solo?: boolean;
  /** reasoning level for this lens */
  thinking?: ThinkingLevel;
  /** glob triggers; empty/"always" => runs on any reviewable change */
  when?: string[];
}

/** The PR under review, assembled in the (untrusted) gather phase and consumed in the (trusted) review phase. */
export interface ReviewContext {
  baseSha: string;
  body: string;
  /** CI check conclusions + annotations, consumed read-only as grounding */
  ciSignals?: CiSignal[];
  /** unified-diff per file + metadata (the only PR-derived input trusted as *data*, never executed) */
  files: ChangedFile[];
  headSha: string;
  /**
   * The issue this PR declares it closes (`Closes #N`), fetched at gather for the AC-conformance check. Its text
   * is UNTRUSTED and attacker-openable (anyone can file an issue, even one the PR author doesn't own) — it is
   * consumed ONLY as user-turn reference data for the AC-check pass (see `renderAnalysisPrompt`, gated on
   * `acCheck`), never injected into a trusted/precedence-taking system preamble. Absent unless a linked issue was
   * found and fetched.
   */
  linkedIssue?: { body: string; number: number; title: string };
  prNumber: number;
  repo: string;
  title: string;
}

export interface ChangedFile {
  patch?: string;
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
}

export interface CiSignal {
  /** file:line-scoped annotations (already lint/test output), fed as grounding, never re-run */
  annotations?: { path: string; line: number; message: string }[];
  check: string;
  conclusion: string;
}
