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

  test("listDir entries are sorted by name (deterministic, filesystem-order-independent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-fsreader-sort-"));
    for (const name of ["z.md", "a.md", "m.md"]) {
      writeFileSync(join(dir, name), "x");
    }
    const entries = await fsRepoReader(dir).listDir("");
    rmSync(dir, { force: true, recursive: true });
    expect(entries).toEqual(["- a.md", "- m.md", "- z.md"]);
  });

  test("refuses path traversal outside the root (reads back null)", async () => {
    const r = fsRepoReader(root);
    expect(await r.readFile("../../etc/passwd")).toBeNull();
    expect(await r.listDir("..")).toBeNull();
  });

  test("the factory takes exactly one required parameter — a weak tripwire against a head-binding param", () => {
    // A tripwire on the trust contract: adding a *non-defaulted* `headSha`/`ref` parameter bumps the arity and
    // fails here. It is deliberately weak — `Function.length` ignores defaulted/rest params, so `headSha = ""`
    // would slip past. The real defense is the wiring test above (the reader never reaches WorkerRequest) plus
    // review; this only catches the most obvious mistake early. Do not treat it as a proof of head-safety.
    expect(fsRepoReader.length).toBe(1);
  });
});
