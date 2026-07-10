/**
 * Rendering review output for GitHub, with markdown-injection defense. Model output (and PR content it may
 * echo) is untrusted: it can carry markup that breaks our comment layout, forges our hidden markers, pings
 * people, or escapes a code fence. `mdSafe` neutralizes that before anything is posted.
 */
import type { Severity } from "../core/types.js";
import type { AggregatedFinding } from "./aggregate.js";

/** Hidden marker on line 1 of the sticky comment, so we can find + update it in place (never duplicate). */
export const STICKY_MARKER = "<!-- squarewright:review -->";

/** Hidden marker on every inline comment, so a re-review can find + delete our prior ones (never accumulate). */
export const INLINE_MARKER = "<!-- squarewright:inline -->";

const SEV_EMOJI: Record<Severity, string> = {
  error: "🔴",
  info: "🔵",
  warning: "🟡",
};

const ZWSP = "​";

/** Neutralize untrusted text before embedding it in a comment. */
export function mdSafe(text: string): string {
  return (
    text
      // forge our own markers / break <details> layout
      .replace(/<!--/g, "&lt;!--")
      .replace(/-->/g, "--&gt;")
      .replace(/<\/?details>/gi, (m) => m.replace("<", "&lt;"))
      // dangerous / people-pinging HTML tags
      .replace(
        /<(\/?)(a|img|script|iframe|style|link|meta|object|embed|form|input|svg)\b/gi,
        "&lt;$1$2"
      )
      // defang raw markdown links/images: [text](url) -> [text](url) with the paren neutralized
      .replace(/\]\(/g, `]${ZWSP}(`)
      // break runs of 3+ backticks so model output can't escape its own fence
      .replace(/`{3,}/g, (m) => m.split("").join(ZWSP))
  );
}

/** Render one inline PR-comment body: the hidden `INLINE_MARKER` on line 1 (so a re-review can find and replace
 * our prior comments), then an optional lens label (which review persona flagged it — "posts like a good
 * colleague"), then the `mdSafe`-neutralized message (so all comment rendering and injection defense live in one
 * layer). Marker-first + `startsWith` matching (like the sticky) means a human "Quote reply" — which prefixes
 * every quoted line with `> ` — can never be mistaken for one of ours; the message is neutralized before the
 * marker is prepended, so an untrusted message can't forge it either. */
export function renderInlineBody(message: string, lens?: string): string {
  const tag = lens ? `**${mdSafe(lens)}** — ` : "";
  return `${INLINE_MARKER}\n\n${tag}${mdSafe(message)}`;
}

/** A review lens (persona) that ran, for attribution + the honesty footer. */
export interface Lens {
  id: string;
  label: string;
}

export interface StickyInput {
  findings: AggregatedFinding[];
  /** the lenses (personas) that ran — for per-finding attribution and the honesty footer roster */
  lenses?: Lens[];
  /** model(s)/lane label for the honesty footer, e.g. "glm-5-turbo" */
  model?: string;
  summary: string;
}

/** Resolve a finding's source id to its friendly lens label (falling back to the raw source). */
function labelResolver(lenses: Lens[]): (source: string) => string {
  const map = new Map(lenses.map((l) => [l.id, l.label]));
  return (source) => map.get(source) ?? source;
}

/** The distinct lens labels behind a finding, e.g. "Correctness, Security". */
function provenance(
  f: AggregatedFinding,
  labelFor: (s: string) => string
): string {
  const labels = [...new Set(f.sources.map(labelFor))];
  if (labels.length === 0) {
    return "";
  }
  const who = mdSafe(labels.join(", "));
  return f.consensus > 1 ? ` _(×${f.consensus}: ${who})_` : ` _[${who}]_`;
}

/** The honesty footer: which lenses ran, on which model, and that a clean/short result reflects only those. */
function honestyFooter(lenses: Lens[], model?: string): string[] {
  if (lenses.length === 0 && !model) {
    return [];
  }
  const parts: string[] = [];
  if (lenses.length > 0) {
    parts.push(`Reviewed by: ${mdSafe(lenses.map((l) => l.label).join(", "))}`);
  }
  if (model) {
    parts.push(mdSafe(model));
  }
  parts.push("findings reflect the enabled lenses only");
  return ["", "---", `_${parts.join(" · ")}_`];
}

/** Render the sticky summary comment (markdown). Safe to post as-is. */
export function renderSticky(input: StickyInput): string {
  const { summary, findings, lenses = [], model } = input;
  const labelFor = labelResolver(lenses);
  const lines: string[] = [STICKY_MARKER, "", "## Squarewright review", ""];

  if (summary.trim()) {
    lines.push(mdSafe(summary.trim()), "");
  }

  if (findings.length === 0) {
    const roster =
      lenses.length > 0
        ? lenses.map((l) => l.label).join(", ")
        : "the enabled lenses";
    lines.push(
      `No issues flagged by ${mdSafe(roster)}${model ? ` on ${mdSafe(model)}` : ""} — it means nothing obvious ` +
        "was found, not that the change is verified correct."
    );
    lines.push(...honestyFooter(lenses, model));
    return lines.join("\n");
  }

  const bySeverity = (s: Severity) => findings.filter((f) => f.severity === s);
  lines.push(
    `**${findings.length}** finding(s): ` +
      (["error", "warning", "info"] as Severity[])
        .map((s) => `${SEV_EMOJI[s]} ${bySeverity(s).length}`)
        .join("  ·  "),
    ""
  );

  for (const f of findings) {
    const loc = `\`${mdSafe(f.path)}:${f.line}\``;
    // A rule-drift proposal (ADR-0005 §2) gets the 📖 marker + a paste-ready block instead of the severity emoji.
    const marker = f.proposedRule ? "📖 `rule-drift`" : SEV_EMOJI[f.severity];
    lines.push(
      `- ${marker} ${loc}${provenance(f, labelFor)} — ${mdSafe(f.message)}`
    );
    if (f.proposedRule) {
      // Paste-ready `.review-rules/*.md` block — a suggestion the human adds; never an auto-write. mdSafe
      // neutralizes any fence-breaking content from the (model-authored) rule text.
      const block = mdSafe(f.proposedRule)
        .split("\n")
        .map((l) => `  ${l}`);
      lines.push(
        "",
        "  **Proposed rule** — paste into `.review-rules/`:",
        "",
        "  ```md",
        ...block,
        "  ```"
      );
    } else if (f.suggestion) {
      lines.push("", "  ```suggestion", `  ${mdSafe(f.suggestion)}`, "  ```");
    }
  }
  lines.push(...honestyFooter(lenses, model));
  return lines.join("\n");
}
