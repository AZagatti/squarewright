import { test, expect } from "bun:test";
import { mdSafe, renderSticky, STICKY_MARKER } from "./render.js";
import type { AggregatedFinding } from "./aggregate.js";

test("mdSafe neutralizes marker forgery, layout breaks, and dangerous tags", () => {
  expect(mdSafe("<!-- squarewright:review -->")).not.toContain("<!--");
  expect(mdSafe("</details>")).not.toContain("</details>");
  expect(mdSafe('<a href="http://evil">x</a>')).not.toContain("<a ");
  expect(mdSafe('<img src=x onerror=1>')).not.toContain("<img");
});

test("mdSafe breaks fences and defangs raw links", () => {
  expect(mdSafe("```js\nalert(1)\n```")).not.toContain("```");
  expect(mdSafe("[click](javascript:alert(1))")).not.toContain("](");
});

test("renderSticky: marker first, clean verdict when empty", () => {
  const out = renderSticky({ summary: "Looks good.", findings: [] });
  expect(out.startsWith(STICKY_MARKER)).toBe(true);
  expect(out).toContain("No blocking issues found");
});

test("renderSticky: lists findings with location and consensus", () => {
  const findings: AggregatedFinding[] = [
    {
      path: "src/a.ts",
      line: 12,
      severity: "error",
      rule: "warden",
      message: "SQL injection via string-built query",
      consensus: 2,
      sources: ["warden", "sentinel"],
    },
  ];
  const out = renderSticky({ summary: "1 issue.", findings });
  expect(out).toContain("`src/a.ts:12`");
  expect(out).toContain("×2");
  expect(out).toContain("🔴");
});
