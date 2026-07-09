import { describe, expect, test } from "bun:test";
import type { RepoReader } from "../pi/session.js";
import {
  loadReviewRules,
  type ReviewRule,
  renderReviewRules,
  selectReviewRules,
} from "./review-rules.js";

/**
 * A RepoReader over an in-memory tree. `dirs` maps a dir path to its `list_repo_dir`-style entries
 * (each `"- name"` for a file, `"d name"` for a subdir — the format the real GitHub-backed reader emits);
 * `files` maps a full path to its contents. Anything absent reads back as null.
 */
function fakeReader(
  dirs: Record<string, string[]>,
  files: Record<string, string>
): RepoReader {
  return {
    listDir: (path) => Promise.resolve(dirs[path] ?? null),
    readFile: (path) =>
      Promise.resolve(path in files ? (files[path] as string) : null),
  };
}

const ARCH = `---
description: Architecture
globs: ["src/**"]
---

- \`src/strategies/*\` must be pure: no I/O, no globals.`;

const CSS_RULE = `---
globs: ["**/*.css"]
---

- Use logical properties (margin-inline) over left/right.`;

const ALWAYS = `---
description: Always
---

- Every public function needs a doc comment.`;

describe("loadReviewRules", () => {
  test("reads .review-rules/*.md, parses frontmatter globs, skips README", async () => {
    const reader = fakeReader(
      { ".review-rules": ["- README.md", "- arch.md", "- css.md"] },
      {
        ".review-rules/arch.md": ARCH,
        ".review-rules/css.md": CSS_RULE,
        ".review-rules/README.md": "# format doc, not a rule",
      }
    );
    const rules = await loadReviewRules(reader);
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.path)).toEqual([
      ".review-rules/arch.md",
      ".review-rules/css.md",
    ]);
    expect(rules[0]?.globs).toEqual(["src/**"]);
    // body is frontmatter-stripped and preserved verbatim
    expect(rules[0]?.body).toBe(
      "- `src/strategies/*` must be pure: no I/O, no globals."
    );
  });

  test("a rule with no globs frontmatter loads with an empty globs list", async () => {
    const reader = fakeReader(
      { ".review-rules": ["- always.md"] },
      { ".review-rules/always.md": ALWAYS }
    );
    const rules = await loadReviewRules(reader);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.globs).toEqual([]);
  });

  test("missing .review-rules directory yields no rules (not an error)", async () => {
    const reader = fakeReader({}, {});
    expect(await loadReviewRules(reader)).toEqual([]);
  });

  test("a directory entry inside .review-rules is ignored", async () => {
    const reader = fakeReader(
      { ".review-rules": ["d nested", "- arch.md"] },
      { ".review-rules/arch.md": ARCH }
    );
    const rules = await loadReviewRules(reader);
    expect(rules.map((r) => r.path)).toEqual([".review-rules/arch.md"]);
  });
});

describe("selectReviewRules", () => {
  const arch: ReviewRule = {
    body: "arch body",
    globs: ["src/**"],
    path: ".review-rules/arch.md",
  };
  const css: ReviewRule = {
    body: "css body",
    globs: ["**/*.css"],
    path: ".review-rules/css.md",
  };
  const always: ReviewRule = {
    body: "always body",
    globs: [],
    path: ".review-rules/always.md",
  };

  test("includes a rule whose glob matches a changed file", () => {
    const sel = selectReviewRules([arch, css], ["src/a.ts"]);
    expect(sel.map((r) => r.path)).toEqual([".review-rules/arch.md"]);
  });

  test("excludes a rule whose glob matches no changed file", () => {
    const sel = selectReviewRules([css], ["src/a.ts"]);
    expect(sel).toEqual([]);
  });

  test("a rule with no globs always applies", () => {
    const sel = selectReviewRules([always], ["docs/x.md"]);
    expect(sel.map((r) => r.path)).toEqual([".review-rules/always.md"]);
  });
});

describe("renderReviewRules", () => {
  test("no rules renders the empty string (nothing injected)", () => {
    expect(renderReviewRules([])).toBe("");
  });

  test("renders a precedence-framed block containing each rule body verbatim", () => {
    const block = renderReviewRules([
      { body: "RULE ONE BODY", globs: [], path: ".review-rules/a.md" },
    ]);
    expect(block).toContain("take precedence");
    expect(block).toContain(".review-rules/a.md");
    expect(block).toContain("RULE ONE BODY");
  });
});
