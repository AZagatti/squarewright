import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  catalogWarnings,
  MODELS_JSON_ENV,
  missingCostWarning,
  missingOverrideWarning,
  resolveModelsJsonPath,
  supersessionWarning,
} from "./model-catalog.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sqw-catalog-"));
}

// ── resolveModelsJsonPath ───────────────────────────────────────────────────

test("resolveModelsJsonPath: SQW_MODELS_JSON override wins when the file exists", () => {
  const dir = tmp();
  const override = join(dir, "custom.json");
  writeFileSync(override, '{"providers":{}}');
  expect(resolveModelsJsonPath({ [MODELS_JSON_ENV]: override }, "/nope")).toBe(
    override
  );
});

test("resolveModelsJsonPath: a set-but-missing override resolves to undefined, not a bad path", () => {
  // A stale SQW_MODELS_JSON degrades to the default catalog (built-ins + any global file), not a non-existent path
  // handed to the registry. `missingOverrideWarning` (below) is what makes that silent degrade loud.
  expect(
    resolveModelsJsonPath({ [MODELS_JSON_ENV]: "/does/not/exist.json" }, tmp())
  ).toBeUndefined();
});

test("resolveModelsJsonPath: falls back to <cwd>/models.json when it exists", () => {
  const dir = tmp();
  const path = join(dir, "models.json");
  writeFileSync(path, '{"providers":{}}');
  expect(resolveModelsJsonPath({}, dir)).toBe(path);
});

test("resolveModelsJsonPath: undefined when no override and no repo-root models.json", () => {
  expect(resolveModelsJsonPath({}, tmp())).toBeUndefined();
});

test("catalogWarnings: scopes the project models.json lookup to the given cwd (#197)", () => {
  // With no SQW_MODELS_JSON override, catalogWarnings must read <cwd>/models.json — so `doctor -C <dir>` inspects
  // the target repo's catalog, not the process's cwd. Isolate the cwd-dependent missing-cost warning.
  const prev = process.env[MODELS_JSON_ENV];
  delete process.env[MODELS_JSON_ENV];
  const COST = "no `cost` block";
  try {
    const withBad = tmp();
    writeFileSync(
      join(withBad, "models.json"),
      JSON.stringify({ providers: { acme: { models: [{ id: "x" }] } } })
    );
    expect(catalogWarnings(withBad).some((w) => w.includes(COST))).toBe(true);
    expect(catalogWarnings(tmp()).some((w) => w.includes(COST))).toBe(false);
  } finally {
    if (prev !== undefined) {
      process.env[MODELS_JSON_ENV] = prev;
    }
  }
});

// ── supersessionWarning (money-safety guard) ────────────────────────────────

const GLOBAL = "/home/u/.pi/agent/models.json";

test("supersessionWarning: warns when a project catalog supersedes an existing global one", () => {
  const w = supersessionWarning("/repo/models.json", GLOBAL, true);
  expect(w).toContain("/repo/models.json");
  expect(w).toContain(GLOBAL);
  expect(w).toContain("does NOT merge");
});

test("supersessionWarning: silent when there is no project catalog", () => {
  expect(supersessionWarning(undefined, GLOBAL, true)).toBeNull();
});

test("supersessionWarning: silent when no global file exists to be superseded", () => {
  expect(supersessionWarning("/repo/models.json", GLOBAL, false)).toBeNull();
});

test("supersessionWarning: silent when the resolved path IS the global path", () => {
  expect(supersessionWarning(GLOBAL, GLOBAL, true)).toBeNull();
});

// ── missingOverrideWarning (money-safety guard: set-but-absent SQW_MODELS_JSON) ──

test("missingOverrideWarning: warns when SQW_MODELS_JSON is set but the file is absent", () => {
  const w = missingOverrideWarning(
    { [MODELS_JSON_ENV]: "/gone/models.json" },
    () => false
  );
  expect(w).toContain("/gone/models.json");
  expect(w).toContain("NOT applied");
  expect(w).toContain(MODELS_JSON_ENV);
});

test("missingOverrideWarning: silent when the override file exists", () => {
  expect(
    missingOverrideWarning({ [MODELS_JSON_ENV]: "/there.json" }, () => true)
  ).toBeNull();
});

test("missingOverrideWarning: silent when the env is unset (benign default, not a misconfig)", () => {
  expect(missingOverrideWarning({}, () => false)).toBeNull();
  // whitespace-only is treated as unset (matches resolveModelsJsonPath's trim)
  expect(
    missingOverrideWarning({ [MODELS_JSON_ENV]: "   " }, () => false)
  ).toBeNull();
});

// ── missingCostWarning (money-safety guard: custom model with no cost → silent $0) ──

const catalog = (models: unknown[]): string =>
  JSON.stringify({ providers: { openrouter: { models } } });

test("missingCostWarning: warns for a custom model declared without a cost block", () => {
  const w = missingCostWarning("/x.json", () =>
    catalog([{ contextWindow: 200_000, id: "newest" }])
  );
  expect(w).toContain("openrouter/newest");
  expect(w).toContain("HIDING real spend");
});

test("missingCostWarning: silent when every model has a cost (incl. an explicit free 0)", () => {
  const w = missingCostWarning("/x.json", () =>
    catalog([
      { cost: { input: 1, output: 2 }, id: "paid" },
      { cost: { input: 0, output: 0 }, id: "free" }, // explicit 0 = genuinely free, not "unpriced"
    ])
  );
  expect(w).toBeNull();
});

test("missingCostWarning: silent when path is undefined or the file is unreadable/malformed", () => {
  expect(missingCostWarning(undefined)).toBeNull();
  expect(
    missingCostWarning("/x.json", () => {
      throw new Error("ENOENT");
    })
  ).toBeNull();
  expect(missingCostWarning("/x.json", () => "{ not json")).toBeNull();
});

// ── merge semantics via a real ModelRegistry (no network — pure file parsing) ──

function registryFor(dir: string, modelsJson: string): ModelRegistry {
  const path = join(dir, "models.json");
  writeFileSync(path, modelsJson);
  // Temp auth path so the test never touches the real ~/.pi/auth.json.
  const auth = AuthStorage.create(join(dir, "auth.json"));
  return ModelRegistry.create(auth, path);
}

test("createModelRegistry path: a custom models.json is merged over built-ins and resolvable by find()", () => {
  const dir = tmp();
  const reg = registryFor(
    dir,
    JSON.stringify({
      providers: {
        openrouter: {
          api: "openai-completions",
          authHeader: true,
          baseUrl: "https://openrouter.ai/api/v1",
          models: [
            {
              contextWindow: 200_000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 1, output: 2 },
              id: "example/newest-model",
              input: ["text"],
              maxTokens: 64_000,
              name: "Newest (test)",
              reasoning: true,
            },
          ],
        },
      },
    })
  );
  expect(reg.getError()).toBeUndefined();
  const model = reg.find("openrouter", "example/newest-model");
  expect(model).toBeDefined();
  expect(model?.id).toBe("example/newest-model");
});

test("createModelRegistry path: a malformed models.json sets getError() and keeps built-ins (never a silent empty catalog)", () => {
  const dir = tmp();
  const reg = registryFor(dir, "{ this is not valid json");
  expect(reg.getError()).toBeDefined();
  // The registry must still expose the built-in catalog — a broken custom file can't zero out models.
  expect(reg.getAll().length).toBeGreaterThan(0);
});
