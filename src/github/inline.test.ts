import { test, expect } from "bun:test";
import { commentableLines, mapToInlineComments } from "./inline.js";
import type { ChangedFile, Finding } from "../core/types.js";

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
  const files: ChangedFile[] = [{ path: "foo.ts", status: "modified", patch: PATCH }];
  const findings: Finding[] = [
    { path: "foo.ts", line: 2, severity: "warning", rule: "r", message: "on an added line" },
    { path: "foo.ts", line: 99, severity: "error", rule: "r", message: "off the diff" },
    { path: "other.ts", line: 1, severity: "info", rule: "r", message: "file not in diff" },
  ];
  const { inline, unplaceable } = mapToInlineComments(findings, files);
  expect(inline).toHaveLength(1);
  expect(inline[0]).toMatchObject({ path: "foo.ts", line: 2 });
  expect(unplaceable.map((f) => f.line).sort((a, b) => a - b)).toEqual([1, 99]);
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
