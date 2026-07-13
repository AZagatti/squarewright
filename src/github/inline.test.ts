import { expect, test } from "bun:test";
import type { ChangedFile, Finding } from "../core/types.js";
import { commentableLines, mapToInlineComments } from "./inline.js";

const PATCH = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,4 +1,5 @@
 line one
-removed old
+added two
+added three
 line four`;

test("commentableLines: added + context on the new side, not removed", () => {
  const lines = commentableLines(PATCH);
  // new-side: 1 (context), 2 (added), 3 (added), 4 (context)
  expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
});

test("mapToInlineComments: places on commentable lines, flags the rest", () => {
  const files: ChangedFile[] = [
    { patch: PATCH, path: "foo.ts", status: "modified" },
  ];
  const findings: Finding[] = [
    {
      line: 2,
      message: "on an added line",
      path: "foo.ts",
      rule: "r",
      severity: "warning",
    },
    {
      line: 99,
      message: "off the diff",
      path: "foo.ts",
      rule: "r",
      severity: "error",
    },
    {
      line: 1,
      message: "file not in diff",
      path: "other.ts",
      rule: "r",
      severity: "info",
    },
  ];
  const { inline, unplaceable } = mapToInlineComments(findings, files);
  expect(inline).toHaveLength(1);
  expect(inline[0]).toMatchObject({ line: 2, path: "foo.ts" });
  expect(unplaceable.map((f) => f.line).sort((a, b) => a - b)).toEqual([1, 99]);
});

test("mapToInlineComments: findings past the cap fold into unplaceable, never dropped", () => {
  // one file whose new side is 50 commentable added lines
  const patch = `@@ -0,0 +1,50 @@\n${Array.from({ length: 50 }, () => "+x").join("\n")}`;
  const files: ChangedFile[] = [{ patch, path: "big.ts", status: "modified" }];
  const findings: Finding[] = Array.from({ length: 45 }, (_, i) => ({
    line: i + 1,
    message: `finding ${i}`,
    path: "big.ts",
    rule: "r",
    severity: "warning" as const,
  }));
  const { inline, unplaceable } = mapToInlineComments(findings, files, {
    cap: 40,
  });
  expect(inline).toHaveLength(40); // inline comments capped
  expect(unplaceable).toHaveLength(5); // the 5 overflow findings are preserved, not silently dropped
  expect(inline.length + unplaceable.length).toBe(findings.length); // total conserved
});

test("mapToInlineComments: neutralizes markdown injection in the finding body", () => {
  const files: ChangedFile[] = [
    { patch: PATCH, path: "foo.ts", status: "modified" },
  ];
  const findings: Finding[] = [
    {
      line: 2,
      message: "<!-- forged --> see [click](http://evil) </details>",
      path: "foo.ts",
      rule: "r",
      severity: "warning",
    },
  ];

  const { inline } = mapToInlineComments(findings, files);

  const [comment] = inline;
  // the forged marker + tags in the message are neutralized (our own hidden marker is added separately)
  expect(comment?.body).not.toContain("<!-- forged");
  expect(comment?.body).not.toContain("</details>");
  // the link paren is defanged so it can't render as a clickable link
  expect(comment?.body).not.toContain("](http");
});

test("mapToInlineComments: prefixes the lens label from labelFor", () => {
  const files: ChangedFile[] = [
    { patch: PATCH, path: "foo.ts", status: "modified" },
  ];
  const findings: Finding[] = [
    {
      line: 2,
      message: "unsafe",
      path: "foo.ts",
      rule: "warden",
      severity: "warning",
      source: "warden",
    },
  ];

  const { inline } = mapToInlineComments(findings, files, {
    labelFor: (s) => (s === "warden" ? "Security" : s),
  });

  expect(inline[0]?.body).toContain("**Security** —");
});

test("commentableLines: multiple hunks track new-side numbering", () => {
  const patch = `--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 a
+b
@@ -10,2 +20,3 @@
 c
+d
 e`;
  const lines = commentableLines(patch);
  // hunk1: 1 (context), 2 (added). hunk2 starts at 20: 20 (context), 21 (added), 22 (context)
  expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 20, 21, 22]);
});
