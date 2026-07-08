import { expect, test } from "bun:test";
import { parseAssemblyConfig } from "../assembly/config.js";
import { DEFAULT_PERSONAS } from "../personas/defaults.js";
import { renderDefaultConfig } from "./default-config.js";

test("renderDefaultConfig is a valid assembly carrying the full default persona set", () => {
  const config = parseAssemblyConfig(renderDefaultConfig());

  const byId = (a: string, b: string) => a.localeCompare(b);
  expect(config.personas.map((p) => p.id).sort(byId)).toEqual(
    DEFAULT_PERSONAS.map((p) => p.id).sort(byId)
  );
});

test("renderDefaultConfig defaults to free z.ai lanes + structurer (only zai required)", () => {
  const config = parseAssemblyConfig(renderDefaultConfig());

  expect(config.lanes.every((l) => l.provider === "zai")).toBe(true);
  expect(config.structurer?.provider).toBe("zai");
});
