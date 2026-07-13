/**
 * Teach-by-reply (ADR-0005 §3): turn a maintainer's reply to a finding
 * (`@squarewright remember: …` / `/squarewright remember …`) into a candidate `.review-rules` block the human
 * copies in — NEVER an auto-write. Built in two parts so the honest, testable core ships first (same shape as §2,
 * where the render/cap core landed before emission):
 *
 *   Part A (THIS module): the PURE pipeline — strip the trigger, gate on confidence, and render an
 *     injection-safe suggestion. Plus the `ReplyInterpreter` seam. No GitHub, no model dependency here, so it is
 *     fully unit-testable and reusable.
 *   Part B (follow-up, infra): a Pi-backed `ReplyInterpreter` (a schema-constrained model call) and a GitHub
 *     workflow triggered by `issue_comment` / `pull_request_review_comment`, **permission-gated** to
 *     write/maintain/admin with the PR author excluded (reuse the Gather workflow's `author_association` gate),
 *     that extracts the reply, calls the interpreter, and posts the suggestion via the `Poster`. It needs **no new
 *     write path** (`pull-requests: write` only; never `contents: write`).
 *
 * Trust boundary: the reply is third-party text. The interpreter (Part B) must DELIMIT and quote it to the model
 * as **data, not instruction** — extract intent, never obey. The output is only ever a suggestion a human pastes;
 * the human step is the injection defense (reliable text sanitization is unsolved), and `renderRuleSuggestion`
 * `mdSafe`s the model-authored rule text so it cannot break out of its fence or forge our markers.
 */
import { INLINE_MARKER, mdSafe } from "../output/render.js";

/** A candidate rule the interpreter extracted from a reply. `confidence` in [0,1]; low-confidence is dropped. */
export interface RuleSuggestion {
  /** the model's self-reported confidence that the reply expresses a durable, generalizable rule (0..1) */
  confidence: number;
  /** the rule stated imperatively — becomes the `.review-rules` entry body */
  ruleText: string;
  /** what the rule applies to (an area/description hint the human turns into `globs`) */
  scope: string;
}

/** Below this confidence a suggestion is dropped — a vague/ambiguous reply must not become an asserted rule. */
export const CONFIDENCE_FLOOR = 0.6;

/**
 * The seam Part B implements: interpret a reply into a candidate rule, or null when the reply carries no durable
 * rule. Injectable so the assembly/tests never need a live model — mirrors `PiWorker`.
 */
export interface ReplyInterpreter {
  interpret: (input: {
    /** the finding the reply is attached to, for grounding (optional) */
    findingText?: string;
    /** the raw reply text — UNTRUSTED; the implementation must treat it as data, not instruction */
    replyText: string;
  }) => Promise<RuleSuggestion | null>;
}

// Intentionally loose: the `remember`/`rule` keyword is OPTIONAL for both the `@`- and `/`-forms, so any
// `@squarewright …` / `/squarewright …` addressed to us is treated as a possible teach reply. Part B's interpreter
// is the real filter — it returns null (via the confidence gate) when the stripped text carries no durable rule.
const TRIGGER_RE =
  /^\s*[/@]squarewright\b[ \t]*(?:remember|rule)?[ \t]*:?[ \t]*/i;

/** Strip a leading `@squarewright`/`/squarewright remember:` trigger so only the user's intent reaches the model. */
export function stripTrigger(replyText: string): string {
  return replyText.replace(TRIGGER_RE, "").trim();
}

/** True when the reply addresses squarewright with a teach trigger (so Part B knows to interpret it at all). */
export function hasTeachTrigger(replyText: string): boolean {
  return TRIGGER_RE.test(replyText);
}

/**
 * Confidence gate: return the suggestion only if it clears the floor and carries a non-empty rule; else null.
 * Pure — the honest "don't assert a rule we're unsure of" boundary, testable without a model.
 */
export function gateSuggestion(
  s: RuleSuggestion | null
): RuleSuggestion | null {
  if (
    !(
      s &&
      Number.isFinite(s.confidence) &&
      s.confidence >= CONFIDENCE_FLOOR &&
      s.ruleText.trim() &&
      s.scope.trim()
    )
  ) {
    return null;
  }
  return s;
}

/**
 * Render a gated suggestion as an injection-safe inline-comment body: the hidden `INLINE_MARKER` (so a re-run can
 * find/replace it, like every other inline comment), then a paste-ready `.review-rules` block. All model-authored
 * text is `mdSafe`d so it cannot break the fence or forge markers. Never call on an ungated suggestion.
 */
export function renderRuleSuggestion(s: RuleSuggestion): string {
  const block = [
    "```md",
    "---",
    `description: ${mdSafe(s.scope)}`,
    "globs: []  # ← set the file globs this rule applies to",
    "---",
    mdSafe(s.ruleText),
    "```",
  ].join("\n");
  return (
    `${INLINE_MARKER}\n\n` +
    "📖 **Suggested rule** from your reply — a human pastes this into `.review-rules/`; " +
    "squarewright never writes it for you:\n\n" +
    block
  );
}

/** The outcome of handling one reply: either a comment body to post, or a skip with a reason (for logs). */
export type TeachOutcome =
  | { body: string; kind: "post" }
  | { kind: "skip"; reason: string };

/**
 * Orchestrate one reply end-to-end (ADR-0005 §3): authorize → detect trigger → strip it → interpret (as DATA) →
 * gate on confidence → render. Enforces gate-before-render structurally (nothing can render an ungated suggestion)
 * and short-circuits before ever calling the model when the reply isn't a teach trigger or the caller isn't
 * authorized. Pure orchestration — inject the `ReplyInterpreter`; the caller (CLI/workflow) posts the body via the
 * `Poster` and does the *primary* permission gate in the workflow (`author_association`); `authorized` here is
 * defense-in-depth so the model is never even invoked for an unauthorized reply.
 */
export async function handleTeachReply(input: {
  /** already permission-checked upstream (workflow author_association); re-checked here as defense-in-depth */
  authorized: boolean;
  findingText?: string;
  interpreter: ReplyInterpreter;
  replyText: string;
}): Promise<TeachOutcome> {
  if (!input.authorized) {
    return { kind: "skip", reason: "unauthorized" };
  }
  if (!hasTeachTrigger(input.replyText)) {
    return { kind: "skip", reason: "no-trigger" };
  }
  const intent = stripTrigger(input.replyText);
  if (!intent) {
    return { kind: "skip", reason: "empty-after-trigger" };
  }
  const gated = gateSuggestion(
    await input.interpreter.interpret({
      findingText: input.findingText,
      replyText: intent,
    })
  );
  if (!gated) {
    return { kind: "skip", reason: "no-durable-rule" };
  }
  return { body: renderRuleSuggestion(gated), kind: "post" };
}
