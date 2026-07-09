import { describe, expect, test } from "bun:test";
import type { RepoReader } from "../pi/session.js";
import {
  type ContextDoc,
  loadContextDocs,
  renderContextDocs,
} from "./context-docs.js";

function reader(files: Record<string, string>): RepoReader {
  return {
    listDir: () => Promise.resolve(null),
    readFile: (path) =>
      Promise.resolve(path in files ? (files[path] as string) : null),
  };
}

describe("loadContextDocs", () => {
  const files = {
    "AGENTS.md": "AGENTS BODY",
    "docs/css.md": "CSS DOC BODY",
  };

  test("loads a doc whose glob matches a changed file", async () => {
    const docs = await loadContextDocs(
      reader(files),
      [{ globs: ["src/**"], path: "AGENTS.md" }],
      ["src/a.ts"]
    );
    expect(docs).toEqual([{ body: "AGENTS BODY", path: "AGENTS.md" }]);
  });

  test("skips a doc whose glob matches no changed file", async () => {
    const docs = await loadContextDocs(
      reader(files),
      [{ globs: ["**/*.css"], path: "docs/css.md" }],
      ["src/a.ts"]
    );
    expect(docs).toEqual([]);
  });

  test("a spec with no globs matches nothing (a background doc must declare when it applies)", async () => {
    const docs = await loadContextDocs(
      reader(files),
      [{ globs: [], path: "AGENTS.md" }],
      ["src/a.ts"]
    );
    expect(docs).toEqual([]);
  });

  test("a missing doc file is skipped (not an error)", async () => {
    const docs = await loadContextDocs(
      reader(files),
      [{ globs: ["src/**"], path: "docs/absent.md" }],
      ["src/a.ts"]
    );
    expect(docs).toEqual([]);
  });

  test("dedups by path when two matching specs point at the same doc", async () => {
    const docs = await loadContextDocs(
      reader(files),
      [
        { globs: ["src/**"], path: "AGENTS.md" },
        { globs: ["**/*.ts"], path: "AGENTS.md" },
      ],
      ["src/a.ts"]
    );
    expect(docs.map((d) => d.path)).toEqual(["AGENTS.md"]);
  });
});

describe("renderContextDocs", () => {
  test("no docs renders the empty string", () => {
    expect(renderContextDocs([])).toBe("");
  });

  test("renders a background block (not precedence) with each body verbatim", () => {
    const docs: ContextDoc[] = [{ body: "DOC BODY", path: "AGENTS.md" }];
    const block = renderContextDocs(docs);
    expect(block).toContain("background context");
    expect(block).toContain("AGENTS.md");
    expect(block).toContain("DOC BODY");
    // it must NOT claim precedence — Tier-A rules win
    expect(block).toContain("the rule wins");
  });
});
