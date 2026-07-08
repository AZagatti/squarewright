import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAssemblyConfig } from "./config.js";

const MINIMAL = `
lanes:
  - id: cheap
    provider: zai
    model: glm-5-turbo
personas:
  - id: gen
    lane: cheap
    prompt: review it
`;

function configDir(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sqw-config-"));
  writeFileSync(join(dir, ".squarewright.yml"), text);
  return dir;
}

describe("loadAssemblyConfig", () => {
  test("loads and validates a .squarewright.yml", () => {
    const config = loadAssemblyConfig(configDir(MINIMAL));
    expect(config.lanes[0]?.id).toBe("cheap");
    expect(config.personas[0]?.lane).toBe("cheap");
  });

  test("accepts an optional structurer lane", () => {
    const config = loadAssemblyConfig(
      configDir(
        `${MINIMAL}structurer:\n  id: struct\n  provider: zai\n  model: glm-5-turbo\n`
      )
    );
    expect(config.structurer?.provider).toBe("zai");
  });

  test("structurer is optional", () => {
    const config = loadAssemblyConfig(configDir(MINIMAL));
    expect(config.structurer).toBeUndefined();
  });

  test("throws a helpful error when the config is missing", () => {
    expect(() => loadAssemblyConfig(join(tmpdir(), "no-config-sqw"))).toThrow(
      "No .squarewright.yml"
    );
  });
});
