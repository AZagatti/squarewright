import { expect, test } from "bun:test";
import type { Finding, ReviewContext } from "../core/types.js";
import { renderPrompt } from "./verifier.js";

const finding: Finding = {
  line: 3,
  message: "possible null deref",
  path: "src/a.ts",
  rule: "persona:gen",
  severity: "warning",
  source: "gen",
};

function ctx(files: ReviewContext["files"]): ReviewContext {
  return {
    baseSha: "",
    body: "",
    files,
    headSha: "",
    prNumber: 1,
    repo: "o/r",
    title: "t",
  };
}

test("renderPrompt: a normal small diff is included in full, untruncated", () => {
  const p = renderPrompt(
    finding,
    ctx([
      { patch: "@@ -1 +1 @@\n-a\n+b\n", path: "src/a.ts", status: "modified" },
    ])
  );
  expect(p).toContain("@@ -1 +1 @@");
  expect(p).not.toContain("diff truncated");
});

test("renderPrompt: an oversized diff is bounded and the truncation is disclosed (eval spend guard)", () => {
  const p = renderPrompt(
    finding,
    ctx([{ patch: "y".repeat(500_000), path: "big.ts", status: "modified" }])
  );
  // capped well below the raw 500k, with the truncation called out
  expect(p).not.toContain("y".repeat(200_100));
  expect(p).toContain("diff truncated");
});
