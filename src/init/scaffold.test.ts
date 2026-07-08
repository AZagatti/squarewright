import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAssemblyConfig } from "../assembly/config.js";
import { scaffold } from "./scaffold.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sqw-scaffold-"));
}

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
