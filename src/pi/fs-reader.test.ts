import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsRepoReader } from "./fs-reader.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sw-fsreader-"));
  mkdirSync(join(root, ".review-rules"));
  writeFileSync(join(root, ".review-rules", "arch.md"), "ARCH BODY");
  mkdirSync(join(root, ".review-rules", "nested"));
});

afterAll(() => rmSync(root, { force: true, recursive: true }));

describe("fsRepoReader", () => {
  test("readFile returns contents; null for a missing file", async () => {
    const r = fsRepoReader(root);
    expect(await r.readFile(".review-rules/arch.md")).toBe("ARCH BODY");
    expect(await r.readFile(".review-rules/missing.md")).toBeNull();
  });

  test("listDir returns `- file` / `d dir` entries; null for a non-dir or missing dir", async () => {
    const r = fsRepoReader(root);
    const entries = await r.listDir(".review-rules");
    expect(entries).toContain("- arch.md");
    expect(entries).toContain("d nested");
    // a file is not a directory → null (matches the RepoReader contract)
    expect(await r.listDir(".review-rules/arch.md")).toBeNull();
    expect(await r.listDir("does-not-exist")).toBeNull();
  });

  test("refuses path traversal outside the root (reads back null)", async () => {
    const r = fsRepoReader(root);
    expect(await r.readFile("../../etc/passwd")).toBeNull();
    expect(await r.listDir("..")).toBeNull();
  });

  test("the factory takes only a root — no SHA/ref parameter, so head-binding is impossible", () => {
    // A regression guard on the trust contract: adding a `headSha`/`ref` parameter would bump the arity and
    // fail here, forcing that change through review instead of silently enabling a PR-head-bound reader.
    expect(fsRepoReader.length).toBe(1);
  });
});
