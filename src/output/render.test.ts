import { expect, test } from "bun:test";
import type { AggregatedFinding } from "./aggregate.js";
import {
  INLINE_MARKER,
  mdSafe,
  renderInlineBody,
  renderSticky,
  STICKY_MARKER,
} from "./render.js";

test("mdSafe neutralizes marker forgery, layout breaks, and dangerous tags", () => {
  expect(mdSafe("<!-- squarewright:review -->")).not.toContain("<!--");
  expect(mdSafe("</details>")).not.toContain("</details>");
  expect(mdSafe('<a href="http://evil">x</a>')).not.toContain("<a ");
  expect(mdSafe("<img src=x onerror=1>")).not.toContain("<img");
});

test("mdSafe breaks fences and defangs raw links", () => {
  expect(mdSafe("```js\nalert(1)\n```")).not.toContain("```");
  expect(mdSafe("[click](javascript:alert(1))")).not.toContain("](");
});

test("renderInlineBody: neutralizes the message, then tags with its own marker", () => {
  const out = renderInlineBody("<!-- forged --> [x](http://evil)");
  // the forged marker + link in the message are neutralized
  expect(out).not.toContain("<!-- forged");
  expect(out).not.toContain("](http");
  // our own marker is appended intact (added after mdSafe, so the message can't forge it)
  expect(out).toContain(INLINE_MARKER);
});

test("renderInlineBody: prefixes the lens label when given", () => {
  expect(renderInlineBody("watch out", "Security")).toContain("**Security** —");
});

test("renderSticky: marker first, honest (not overclaiming) clean verdict", () => {
  const out = renderSticky({
    findings: [],
    lenses: [{ id: "baseline", label: "Correctness, Security" }],
    model: "glm-5-turbo",
    summary: "Looks good.",
  });
  expect(out.startsWith(STICKY_MARKER)).toBe(true);
  // names the enabled lenses + model, and does NOT claim the change is verified correct
  expect(out).toContain("No issues flagged by Correctness, Security");
  expect(out).toContain("glm-5-turbo");
  expect(out).toContain("not that the change is verified correct");
  // honesty footer
  expect(out).toContain("Reviewed by: Correctness, Security");
  expect(out).toContain("findings reflect the enabled lenses only");
});

test("renderSticky: a rule-drift finding renders the 📖 marker + a paste-ready block", () => {
  const findings: AggregatedFinding[] = [
    {
      consensus: 1,
      line: 15,
      message: "New auth pattern should be a documented project rule",
      path: "src/api.ts",
      proposedRule:
        '---\nglobs: ["src/**"]\n---\n- Use fetchWithAuth for protected endpoints.',
      rule: "rule-drift",
      severity: "info",
      sources: ["baseline"],
    },
  ];
  const out = renderSticky({
    findings,
    lenses: [{ id: "baseline", label: "Correctness" }],
    summary: "",
  });
  expect(out).toContain("📖 `rule-drift`");
  expect(out).toContain("Proposed rule");
  expect(out).toContain("```md");
  expect(out).toContain("Use fetchWithAuth for protected endpoints.");
  // it must NOT render as a one-click code ```suggestion (that's for single-line replacements)
  expect(out).not.toContain("```suggestion");
});

test("renderSticky: attributes findings to their lens(es) and names the agreeing lenses", () => {
  const findings: AggregatedFinding[] = [
    {
      consensus: 2,
      line: 12,
      message: "SQL injection via string-built query",
      path: "src/a.ts",
      rule: "warden",
      severity: "error",
      // two DISTINCT lenses independently raised it → a real ×2 agreement
      sources: ["correctness", "security"],
    },
  ];
  const out = renderSticky({
    findings,
    lenses: [
      { id: "correctness", label: "Correctness" },
      { id: "security", label: "Security" },
    ],
    summary: "1 issue.",
  });
  expect(out).toContain("`src/a.ts:12`");
  expect(out).toContain("🔴");
  // the "×N" reflects DISTINCT lenses that agreed, resolved to friendly labels
  expect(out).toContain("×2: Correctness, Security");
});

test("renderSticky: a finding merged twice from ONE lens is NOT shown as ×2 (no false agreement)", () => {
  const findings: AggregatedFinding[] = [
    {
      // consensus (raw merge count) is 2, but only ONE distinct source raised it — must NOT read as "×2 personas"
      consensus: 2,
      line: 12,
      message: "duplicate-ish finding folded within one pass",
      path: "src/a.ts",
      rule: "correctness",
      severity: "warning",
      sources: ["correctness"],
    },
  ];
  const out = renderSticky({
    findings,
    lenses: [{ id: "correctness", label: "Correctness" }],
    summary: "1 issue.",
  });
  expect(out).toContain("_[Correctness]_");
  expect(out).not.toContain("×2");
});

test("renderSticky: resolves + de-dupes labels across two distinct sources", () => {
  const findings: AggregatedFinding[] = [
    {
      consensus: 2,
      line: 5,
      message: "same issue seen by two passes",
      path: "a.ts",
      rule: "baseline",
      severity: "warning",
      sources: ["baseline", "chromatic"],
    },
  ];
  const out = renderSticky({
    findings,
    lenses: [
      { id: "baseline", label: "Correctness" },
      { id: "chromatic", label: "CSS" },
    ],
    summary: "",
  });
  // both distinct pass ids resolve to their labels
  expect(out).toContain("×2: Correctness, CSS");
});

test("renderSticky: a single-lens finding shows a bare lens tag, not a consensus count", () => {
  const findings: AggregatedFinding[] = [
    {
      consensus: 1,
      line: 3,
      message: "unpinned action",
      path: ".github/w.yml",
      rule: "marshal",
      severity: "warning",
      sources: ["marshal"],
    },
  ];
  const out = renderSticky({
    findings,
    lenses: [{ id: "marshal", label: "CI" }],
    summary: "",
  });
  expect(out).toContain("_[CI]_");
  expect(out).not.toContain("×1");
});

test("renderSticky: a failed lens is disclosed as incomplete, not hidden behind a clean verdict", () => {
  const out = renderSticky({
    findings: [],
    incompleteLenses: [{ id: "sentinel", label: "Correctness" }],
    lenses: [{ id: "sentinel", label: "Correctness" }],
    summary: "",
  });
  // the failure is called out prominently and explicitly denied a clean reading
  expect(out).toContain("Incomplete review");
  expect(out).toContain("Correctness");
  expect(out).toContain("not** reviewed");
});

test("renderSticky: an errored lens is disclosed as a review error, not a clean verdict", () => {
  const out = renderSticky({
    erroredLenses: [{ id: "sentinel", label: "Correctness" }],
    findings: [],
    lenses: [{ id: "sentinel", label: "Correctness" }],
    summary: "",
  });
  // a lens lost to a mid-run error is called out prominently and explicitly denied a clean reading
  expect(out).toContain("Review error");
  expect(out).toContain("Correctness");
  expect(out).toContain("not** reviewed");
  // distinct wording from the structurer-didn't-submit case
  expect(out).not.toContain("Incomplete review");
});

test("renderSticky: cap-dropped lenses are disclosed as capped coverage", () => {
  const out = renderSticky({
    droppedLenses: [{ id: "marshal", label: "CI" }],
    findings: [],
    lenses: [
      { id: "sentinel", label: "Correctness" },
      { id: "warden", label: "Security" },
    ],
    summary: "",
  });
  expect(out).toContain("Coverage capped");
  expect(out).toContain("CI");
  // names the count so a reader knows how much was skipped
  expect(out).toContain("1 matched lens");
});

test("renderSticky: incomplete AND capped disclosures coexist as one well-formed block", () => {
  const out = renderSticky({
    droppedLenses: [{ id: "marshal", label: "CI" }],
    findings: [],
    incompleteLenses: [{ id: "sentinel", label: "Correctness" }],
    lenses: [{ id: "sentinel", label: "Correctness" }],
    summary: "",
  });
  // both warnings render (they share the leading `> ` blockquote), neither suppresses the other
  expect(out).toContain("Incomplete review");
  expect(out).toContain("Coverage capped");
  expect(out).toContain("Correctness");
  expect(out).toContain("CI");
});

test("renderSticky: full coverage renders no disclosure block (normal review unchanged)", () => {
  const out = renderSticky({
    findings: [],
    lenses: [{ id: "sentinel", label: "Correctness" }],
    summary: "",
  });
  expect(out).not.toContain("Incomplete review");
  expect(out).not.toContain("Coverage capped");
});

test("renderSticky: a non-finite line renders as '?' and cannot forge the sticky marker", () => {
  const findings: AggregatedFinding[] = [
    {
      consensus: 1,
      // a non-strict tool call freelanced a non-numeric line carrying our hidden marker
      line: "<!-- squarewright:review -->" as unknown as number,
      message: "bad",
      path: "src/a.ts",
      rule: "r",
      severity: "warning",
      sources: ["r"],
    },
  ];
  const out = renderSticky({ findings, summary: "x" });
  expect(out).toContain("src/a.ts:?"); // coerced, not the injected text
  // the marker appears exactly once — the real one on line 1, never forged via the line field
  expect(out.split("<!-- squarewright:review -->").length - 1).toBe(1);
});

test("renderSticky: a single huge finding message is clipped", () => {
  const findings: AggregatedFinding[] = [
    {
      consensus: 1,
      line: 1,
      message: "y".repeat(5000),
      path: "src/a.ts",
      rule: "r",
      severity: "warning",
      sources: ["r"],
    },
  ];
  const out = renderSticky({ findings, summary: "x" });
  expect(out).toContain("…"); // clipped
  expect(out.length).toBeLessThan(3000); // not the full 5000-char message
});

test("renderSticky: an oversize review is truncated under GitHub's limit, with a notice", () => {
  const findings: AggregatedFinding[] = Array.from({ length: 200 }, (_, i) => ({
    consensus: 1,
    line: i + 1,
    message: "x".repeat(2000),
    path: "src/a.ts",
    rule: "r",
    severity: "warning" as const,
    sources: ["r"],
  }));
  const out = renderSticky({ findings, summary: "many findings" });
  expect(out.length).toBeLessThanOrEqual(60_000);
  expect(out).toContain("truncated to fit");
  expect(out.startsWith("<!-- squarewright:review -->")).toBe(true); // marker survives truncation
});
