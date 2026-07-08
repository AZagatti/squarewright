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

/** Render one inline PR-comment body: `mdSafe`-neutralized like the sticky (so all comment rendering and
 * injection defense live in one layer), then tagged with the hidden `INLINE_MARKER` so a re-review can find and
 * replace it. The marker is appended after `mdSafe`, so an untrusted message can't forge it. */
export function renderInlineBody(message: string): string {
  return `${mdSafe(message)}\n\n${INLINE_MARKER}`;
}

export interface StickyInput {
  findings: AggregatedFinding[];
  summary: string;
  /** findings that couldn't be placed inline, to list in the summary body */
  unplaceable?: AggregatedFinding[];
}

/** Render the sticky summary comment (markdown). Safe to post as-is. */
export function renderSticky(input: StickyInput): string {
  const { summary, findings } = input;
  const lines: string[] = [STICKY_MARKER, "", "## Squarewright review", ""];

  if (summary.trim()) {
    lines.push(mdSafe(summary.trim()), "");
  }

  if (findings.length === 0) {
    lines.push("No blocking issues found. ✅");
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
    const consensus = f.consensus > 1 ? ` _(×${f.consensus})_` : "";
    lines.push(
      `- ${SEV_EMOJI[f.severity]} ${loc}${consensus} — ${mdSafe(f.message)}`
    );
    if (f.suggestion) {
      lines.push("", "  ```suggestion", `  ${mdSafe(f.suggestion)}`, "  ```");
    }
  }
  return lines.join("\n");
}
