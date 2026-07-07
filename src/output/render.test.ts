import { expect, test } from "bun:test";
import type { AggregatedFinding } from "./aggregate.js";
import { mdSafe, renderSticky, STICKY_MARKER } from "./render.js";

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

test("renderSticky: marker first, clean verdict when empty", () => {
  const out = renderSticky({ findings: [], summary: "Looks good." });
  expect(out.startsWith(STICKY_MARKER)).toBe(true);
  expect(out).toContain("No blocking issues found");
});

test("renderSticky: lists findings with location and consensus", () => {
  const findings: AggregatedFinding[] = [
    {
      consensus: 2,
      line: 12,
      message: "SQL injection via string-built query",
      path: "src/a.ts",
      rule: "warden",
      severity: "error",
      sources: ["warden", "sentinel"],
    },
  ];
  const out = renderSticky({ findings, summary: "1 issue." });
  expect(out).toContain("`src/a.ts:12`");
  expect(out).toContain("×2");
  expect(out).toContain("🔴");
});
