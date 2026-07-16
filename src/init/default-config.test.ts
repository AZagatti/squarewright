import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseAssemblyConfig } from "../assembly/config.js";
import { DEFAULT_PERSONAS } from "../personas/defaults.js";
import { renderDefaultConfig } from "./default-config.js";

test("renderDefaultConfig round-trips the full DEFAULT_PERSONAS (every field, not just ids)", () => {
  const config = parseAssemblyConfig(renderDefaultConfig());

  // deep-equal the whole persona objects so a dropped schema field (e.g. `thinking`) fails here
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id);
  expect([...config.personas].sort(byId)).toEqual(
    [...DEFAULT_PERSONAS].sort(byId)
  );
});

test("renderDefaultConfig defaults to z.ai lanes + structurer (only zai required)", () => {
  const config = parseAssemblyConfig(renderDefaultConfig());

  expect(config.lanes.every((l) => l.provider === "zai")).toBe(true);
  expect(config.structurer?.provider).toBe("zai");
});

test("the repo's own dogfood .squarewright.yml is the generated default (doesn't drift)", () => {
  // if this fails, DEFAULT_PERSONAS/lanes changed — regenerate the committed config (or update this guard if
  // the dogfood config is intentionally customized).
  const committed = readFileSync(
    new URL("../../.squarewright.yml", import.meta.url),
    "utf8"
  );

  expect(committed).toBe(renderDefaultConfig());
});
