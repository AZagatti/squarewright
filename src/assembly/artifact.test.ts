import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGatherArtifact } from "./artifact.js";

function fixtureDir(files: unknown, meta: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "sqw-artifact-"));
  writeFileSync(join(dir, "pr-files.json"), JSON.stringify(files));
  writeFileSync(join(dir, "pr-meta.json"), JSON.stringify(meta));
  return dir;
}

describe("readGatherArtifact", () => {
  test("maps gather JSON into a ReviewContext", () => {
    const dir = fixtureDir(
      [
        { filename: "src/a.ts", patch: "@@ x @@", status: "modified" },
        { filename: "new.ts", status: "added" },
        { filename: "gone.ts", status: "removed" },
        { filename: "moved.ts", status: "renamed" },
        { filename: "weird.ts", status: "changed" },
      ],
      {
        base_sha: "b",
        body: null,
        head_sha: "h",
        number: 7,
        repo: "o/r",
        title: "t",
      }
    );
    const ctx = readGatherArtifact(dir);

    expect(ctx.repo).toBe("o/r");
    expect(ctx.prNumber).toBe(7);
    expect(ctx.baseSha).toBe("b");
    expect(ctx.headSha).toBe("h");
    expect(ctx.body).toBe(""); // null body → ""
    expect(ctx.files).toHaveLength(5);
    expect(ctx.files[0]).toEqual({
      patch: "@@ x @@",
      path: "src/a.ts",
      status: "modified",
    });
    expect(ctx.files[1]?.status).toBe("added");
    expect(ctx.files[2]?.status).toBe("removed");
    expect(ctx.files[3]?.status).toBe("renamed");
    expect(ctx.files[4]?.status).toBe("modified"); // "changed" collapses
  });

  test("throws a helpful error when the artifact is missing", () => {
    expect(() =>
      readGatherArtifact(join(tmpdir(), "does-not-exist-sqw"))
    ).toThrow("Cannot read gather artifact");
  });
});
