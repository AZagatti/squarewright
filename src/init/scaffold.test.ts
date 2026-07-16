import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAssemblyConfig } from "../assembly/config.js";
import { scaffold } from "./scaffold.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sqw-scaffold-"));
}

const REF_LINE = /SQUAREWRIGHT_REF: "([^"]+)"/;
const CONCRETE_REF = /^([0-9a-f]{40}|main)$/;

test("scaffold writes a valid generated config + the workflow files", async () => {
  const dir = tmp();

  await scaffold(dir);

  const config = parseAssemblyConfig(
    readFileSync(join(dir, ".squarewright.yml"), "utf8")
  );
  expect(config.personas.length).toBeGreaterThan(1);
  expect(config.lanes.length).toBeGreaterThan(0);
  // the workflow files are copied alongside the generated config
  expect(
    readFileSync(join(dir, ".github/workflows/squarewright-gather.yml"), "utf8")
      .length
  ).toBeGreaterThan(0);
});

test("scaffold is idempotent — a second run does not overwrite an edited config", async () => {
  const dir = tmp();

  await scaffold(dir);
  const configPath = join(dir, ".squarewright.yml");
  const edited = `${readFileSync(configPath, "utf8")}\n# user edit\n`;
  writeFileSync(configPath, edited);

  await scaffold(dir);

  expect(readFileSync(configPath, "utf8")).toBe(edited);
});

test("scaffolded review + teach workflows install a runnable pinned harness, not a dead placeholder (#193)", async () => {
  const dir = tmp();

  await scaffold(dir);

  const review = readFileSync(
    join(dir, ".github/workflows/squarewright-review.yml"),
    "utf8"
  );
  // the old dead-echo / unpublished-binary placeholder is gone
  expect(review).not.toContain('echo "Install the squarewright CLI here');
  expect(review).not.toContain("pending v0.1 publish");
  // a real, runnable install: clone the public harness at a ref, run it from source with bun
  expect(review).toContain("git clone");
  expect(review).toContain("github.com/AZagatti/squarewright");
  expect(review).toContain(
    'bun "$RUNNER_TEMP/squarewright/src/cli.ts" review --phase post --post'
  );
  // the ref placeholder is substituted with a concrete ref (a SHA or `main`), never left literal
  expect(review).not.toContain("__SQW_REF__");
  const ref = review.match(REF_LINE)?.[1];
  expect(ref).toBeDefined();
  expect(ref as string).toMatch(CONCRETE_REF);

  const teach = readFileSync(
    join(dir, ".github/workflows/squarewright-teach.yml"),
    "utf8"
  );
  expect(teach).not.toContain("__SQW_REF__");
  expect(teach).toContain('bun "$RUNNER_TEMP/squarewright/src/cli.ts" teach');
});
