import { expect, test } from "bun:test";
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

test("renderDefaultConfig defaults to free z.ai lanes + structurer (only zai required)", () => {
  const config = parseAssemblyConfig(renderDefaultConfig());

  expect(config.lanes.every((l) => l.provider === "zai")).toBe(true);
  expect(config.structurer?.provider).toBe("zai");
});
