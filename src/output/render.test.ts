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

test("renderSticky: attributes findings to their lens(es) and names the agreeing lenses", () => {
  const findings: AggregatedFinding[] = [
    {
      consensus: 2,
      line: 12,
      message: "SQL injection via string-built query",
      path: "src/a.ts",
      rule: "warden",
      severity: "error",
      sources: ["baseline"],
    },
  ];
  const out = renderSticky({
    findings,
    lenses: [{ id: "baseline", label: "Correctness, Security" }],
    summary: "1 issue.",
  });
  expect(out).toContain("`src/a.ts:12`");
  expect(out).toContain("🔴");
  // consensus count + which lens(es) flagged it, resolved to the friendly label
  expect(out).toContain("×2: Correctness, Security");
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
