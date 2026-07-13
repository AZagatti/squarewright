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

  const META = (body: string) => ({
    base_sha: "b",
    body,
    head_sha: "h",
    number: 7,
    repo: "o/r",
    title: "t",
  });

  test("no linked-issue.json → linkedIssue is undefined (safe default)", () => {
    const dir = fixtureDir([], META("Closes #42"));
    expect(readGatherArtifact(dir).linkedIssue).toBeUndefined();
  });

  test("linked-issue.json referenced by the PR body → populated", () => {
    const dir = fixtureDir([], META("Fixes #42 — the thing"));
    writeFileSync(
      join(dir, "linked-issue.json"),
      JSON.stringify({ body: "AC: must do X", number: 42, title: "Do X" })
    );
    expect(readGatherArtifact(dir).linkedIssue).toEqual({
      body: "AC: must do X",
      number: 42,
      title: "Do X",
    });
  });

  test("linked-issue.json NOT referenced by the PR body → dropped (consistency guard)", () => {
    // the gather phase is untrusted; only accept an issue the PR body actually declares it closes
    const dir = fixtureDir([], META("See #42 for context")); // no closing keyword
    writeFileSync(
      join(dir, "linked-issue.json"),
      JSON.stringify({ body: "sneaky", number: 99, title: "Unrelated" })
    );
    expect(readGatherArtifact(dir).linkedIssue).toBeUndefined();
  });

  // --- validation of the UNTRUSTED artifact (a forged/malformed gather output must fail cleanly here,
  // not crash later inside prompt assembly: ctx.body.trim(), files.map(...), defangIssueFence) ---

  test("wrong-typed pr-meta field (numeric body) fails with a clear error, not a later crash", () => {
    const dir = fixtureDir([], {
      base_sha: "b",
      body: 12_345, // attacker-controlled: a number would crash ctx.body.trim()
      head_sha: "h",
      number: 7,
      repo: "o/r",
      title: "t",
    });
    expect(() => readGatherArtifact(dir)).toThrow("Malformed gather artifact");
  });

  test("pr-files.json that isn't an array fails in readJson, not in .map()", () => {
    const dir = fixtureDir({ not: "an array" }, META("body"));
    expect(() => readGatherArtifact(dir)).toThrow("Malformed gather artifact");
  });

  test("a file entry missing required fields fails validation", () => {
    const dir = fixtureDir([{ status: "modified" }], META("body")); // no filename
    expect(() => readGatherArtifact(dir)).toThrow("Malformed gather artifact");
  });

  test("malformed linked-issue.json (wrong-typed title) is dropped, never crashes", () => {
    const dir = fixtureDir([], META("Fixes #42"));
    writeFileSync(
      join(dir, "linked-issue.json"),
      JSON.stringify({ body: "x", number: 42, title: { evil: true } })
    );
    expect(readGatherArtifact(dir).linkedIssue).toBeUndefined();
  });

  test("linked-issue.json with a nullish body/title populates with safe empty strings", () => {
    const dir = fixtureDir([], META("Fixes #42"));
    writeFileSync(
      join(dir, "linked-issue.json"),
      JSON.stringify({ number: 42 }) // body + title omitted
    );
    expect(readGatherArtifact(dir).linkedIssue).toEqual({
      body: "",
      number: 42,
      title: "",
    });
  });
});
