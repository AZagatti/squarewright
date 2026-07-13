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

/** Per-finding text cap — keeps one pathological field from dominating (or blowing) the comment. */
const MAX_FIELD = 1200;
/** GitHub rejects a comment body over 65536 chars, failing the WHOLE post. Stay safely under so a big review still posts. */
const MAX_BODY = 60_000;

/** Truncate untrusted text to `max` chars (before escaping, so we never cut an HTML entity in half). */
function clip(s: string, max = MAX_FIELD): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * A finding's `line` is typed `number`, but the structurer's tool call is non-strict (a model can freelance a
 * non-numeric value), and it's interpolated into markdown — so coerce anything non-finite to "?" rather than let
 * crafted text reach the comment unescaped (where it could forge our hidden markers).
 */
function safeLine(line: number): string {
  return Number.isFinite(line) ? String(line) : "?";
}

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
  /**
   * Lenses that MATCHED the change-set but were cut by the persona cap (see `selectPersonasWithDrops`). Disclosed
   * so a capped review never implies it covered a lens it silently dropped. Absent/empty = full coverage.
   */
  droppedLenses?: Lens[];
  findings: AggregatedFinding[];
  /**
   * Lenses whose analysis never produced structured findings (the structurer never called submit_findings —
   * `WorkerResult.usage.submitted === false`). These ran but FAILED; their absence of findings is NOT a clean
   * verdict. Disclosed so a failed pass never masquerades as "nothing found". Absent/empty = every lens submitted.
   */
  incompleteLenses?: Lens[];
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
  // Count DISTINCT lenses, not the raw merge count: "×N" means N personas independently agreed, so a finding
  // merged twice from one source must not read as "×2 personas" (which `f.consensus` would wrongly show).
  return labels.length > 1 ? ` _(×${labels.length}: ${who})_` : ` _[${who}]_`;
}

/**
 * Coverage disclosure — the honesty guard for the production ship-path (mirrors the eval-side `ungradedWarning`).
 * A failed structurer (`incompleteLenses`) or a cap-dropped lens (`droppedLenses`) must never hide behind a
 * "nothing found" verdict, so this renders a prominent block ABOVE the body in both the clean and has-findings
 * paths. Returns [] when coverage was complete, so a normal review is unchanged.
 */
function coverageWarnings(
  droppedLenses: Lens[],
  incompleteLenses: Lens[]
): string[] {
  const lines: string[] = [];
  if (incompleteLenses.length > 0) {
    const who = mdSafe(incompleteLenses.map((l) => l.label).join(", "));
    lines.push(
      `> ⚠️ **Incomplete review** — ${who} did not return structured findings (the analysis was not submitted). ` +
        "That part of the change was **not** reviewed; the absence of findings from it is a failure, not a clean bill."
    );
  }
  if (droppedLenses.length > 0) {
    const who = mdSafe(droppedLenses.map((l) => l.label).join(", "));
    lines.push(
      `> ⚠️ **Coverage capped** — ${droppedLenses.length} matched lens(es) were not run to stay within the review ` +
        `cap: ${who}. Code they target may be unreviewed.`
    );
  }
  return lines.length > 0 ? [...lines, ""] : [];
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
  const {
    summary,
    findings,
    lenses = [],
    model,
    droppedLenses = [],
    incompleteLenses = [],
  } = input;
  const labelFor = labelResolver(lenses);
  const lines: string[] = [STICKY_MARKER, "", "## Squarewright review", ""];

  if (summary.trim()) {
    lines.push(mdSafe(summary.trim()), "");
  }

  // Disclose incomplete/capped coverage prominently, before the verdict body — so it qualifies a "nothing found"
  // clean message and a findings list alike (a review that couldn't cover everything must say so).
  lines.push(...coverageWarnings(droppedLenses, incompleteLenses));

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
    const loc = `\`${mdSafe(f.path)}:${safeLine(f.line)}\``;
    // A rule-drift proposal (ADR-0005 §2) gets the 📖 marker + a paste-ready block instead of the severity emoji.
    const marker = f.proposedRule ? "📖 `rule-drift`" : SEV_EMOJI[f.severity];
    lines.push(
      `- ${marker} ${loc}${provenance(f, labelFor)} — ${mdSafe(clip(f.message))}`
    );
    if (f.proposedRule) {
      // Paste-ready `.review-rules/*.md` block — a suggestion the human adds; never an auto-write. mdSafe
      // neutralizes any fence-breaking content from the (model-authored) rule text.
      const block = mdSafe(clip(f.proposedRule))
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
      lines.push(
        "",
        "  ```suggestion",
        `  ${mdSafe(clip(f.suggestion))}`,
        "  ```"
      );
    }
  }
  lines.push(...honestyFooter(lenses, model));
  const body = lines.join("\n");
  if (body.length <= MAX_BODY) {
    return body;
  }
  // Last-resort safety net: even with per-field caps, a review with very many findings could exceed GitHub's
  // limit and fail to post entirely. Truncate to fit and say so — a degraded comment beats no comment.
  const notice = "\n\n_…review truncated to fit GitHub's comment size limit._";
  return body.slice(0, MAX_BODY - notice.length) + notice;
}
