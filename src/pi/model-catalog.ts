/**
 * Project-controlled model catalog (issue #76). Pi's `ModelRegistry` ships a built-in catalog that lags its
 * live one — a model Pi already knows about upstream (e.g. a newest OpenRouter release) is unreachable until the
 * pinned package is upgraded, surfacing as `Model not found in Pi's catalog`. Pi's escape hatch is a custom
 * `models.json`: `ModelRegistry.create(authStorage, path)` loads that file's providers and merges them over the
 * built-in models (custom wins on conflict). This module is the single seam that resolves the project's
 * `models.json` path and passes it in, so every model-using lane sees the same catalog.
 *
 * IMPORTANT (money safety, AGENTS.md §4): Pi loads exactly ONE `models.json` — the one whose path is passed —
 * it does NOT also merge `~/.pi/agent/models.json` (Pi's default). So a project `models.json` REPLACES, not
 * augments, any global one. If the global file holds cost/reasoning-trap overrides (e.g. a `maxTokens` cap on a
 * reasoning-mandatory model), those must be ported into the project file or they stop applying. When a project
 * catalog supersedes an existing global one, `createModelRegistry` warns loudly rather than swap it silently.
 *
 * Scope note: this ships the LOADER and a documented `models.json.example` template only. Curating WHICH newest
 * models to add is a product/API-shape decision left to the maintainer — drop a real `models.json` at the repo
 * root (or point `SQW_MODELS_JSON` at one) and every lane picks it up. See `models.json.example`,
 * `docs/reference/custom-model-catalog.md`, and Pi's `docs/models.md` for the schema.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuthStorage,
  getAgentDir,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

/** Env var pointing at an explicit models.json path, overriding the repo-root default (mainly for tests/tools). */
export const MODELS_JSON_ENV = "SQW_MODELS_JSON";

/** Pi's default per-user catalog path (`~/.pi/agent/models.json`) — the one a project file supersedes. */
export function globalModelsJsonPath(): string {
  return join(getAgentDir(), "models.json");
}

/**
 * Resolve the project's `models.json`: an explicit `SQW_MODELS_JSON` path wins; otherwise `models.json` at the
 * working directory root (mirrors how `.squarewright.yml` is located). Returns `undefined` when neither exists,
 * so absence is distinctly "no project catalog" (built-ins + whatever global file Pi loads by default), never a
 * load error. Pure but for the fs existence check, so it's testable against a fixture dir.
 */
export function resolveModelsJsonPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string | undefined {
  const override = env[MODELS_JSON_ENV]?.trim();
  if (override) {
    return existsSync(override) ? override : undefined;
  }
  const candidate = join(cwd, "models.json");
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Warn text for a SET-but-ABSENT `SQW_MODELS_JSON`: the operator explicitly pointed at a catalog (likely one
 * carrying cost/reasoning-trap `maxTokens` caps) but no file exists there. `resolveModelsJsonPath` then returns
 * `undefined` — indistinguishable from "no catalog configured" — so the review silently falls back to the default
 * catalog and those caps stop applying, with no signal. This guard makes the money-relevant "set but missing" case
 * loud, distinct from the benign "env unset" default. Returns `null` when the env is unset or the file exists.
 * Pure: `fileExists` is injected so it's testable without a real fs.
 */
export function missingOverrideWarning(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync
): string | null {
  const override = env[MODELS_JSON_ENV]?.trim();
  if (!override || fileExists(override)) {
    return null;
  }
  return `⚠️  ${MODELS_JSON_ENV} is set to "${override}" but no file exists there — ignoring it and falling back to the default catalog (built-ins + any global ${globalModelsJsonPath()}). Any cost/reasoning-trap overrides you intended are NOT applied; fix the path or unset ${MODELS_JSON_ENV}.`;
}

/**
 * Warn text for the one case that silently drops safety settings: a project catalog is active (`resolved` set)
 * AND a different global `~/.pi/agent/models.json` exists on disk. Pi will load only `resolved`, so the global
 * file — possibly holding cost-trap `maxTokens` caps — stops applying. Returns `null` when there's nothing to
 * warn about (no project catalog, or no global file, or they're the same path). Pure: `globalExists` is injected
 * so it's testable without touching the real home dir.
 */
export function supersessionWarning(
  resolved: string | undefined,
  globalPath: string,
  globalExists: boolean
): string | null {
  if (!resolved || resolved === globalPath || !globalExists) {
    return null;
  }
  return `⚠️  project models.json (${resolved}) supersedes your global ${globalPath} — Pi loads only one catalog, it does NOT merge them. Any cost/reasoning-trap overrides in the global file must be ported into the project file or they stop applying.`;
}

/**
 * Warn text for custom `models.json` models declared WITHOUT a `cost` block (#160). Pi's schema makes `cost`
 * optional, so such a model loads fine — but every request through its lane then reports `usage.cost.total === 0`,
 * silently hiding real spend (AGENTS.md §4). Reads the RAW catalog because the parsed registry can't tell "unpriced"
 * (0 by omission) from "genuinely free" (an explicit `cost` of 0). Returns null when the path is absent/unreadable
 * or every model carries a `cost`. Pure: `read` is injected so it's testable without a real file.
 */
export function missingCostWarning(
  path: string | undefined,
  read: (p: string) => string = (p) => readFileSync(p, "utf8")
): string | null {
  if (!path) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read(path));
  } catch {
    return null; // malformed catalogs are handled by getError()'s warning downstream
  }
  if (typeof raw !== "object" || raw === null) {
    return null; // JSON.parse can yield null / a non-object — nothing to inspect
  }
  const { providers } = raw as {
    providers?: Record<string, { models?: { cost?: unknown; id?: string }[] }>;
  };
  if (!providers || typeof providers !== "object") {
    return null;
  }
  const missing: string[] = [];
  for (const [prov, def] of Object.entries(providers)) {
    for (const m of def?.models ?? []) {
      if (m && typeof m === "object" && !("cost" in m)) {
        missing.push(`${prov}/${m.id ?? "(no id)"}`);
      }
    }
  }
  if (missing.length === 0) {
    return null;
  }
  return `⚠️  models.json: ${missing.length} custom model(s) declared with no \`cost\` block (${missing.join(", ")}) — Pi loads them, but every request reports $0 cost, HIDING real spend. Add a cost block (per-token input/output) to each.`;
}

/**
 * All money/honesty warnings for the resolved `models.json` catalog (AGENTS.md §4/§5), in a stable order: a
 * SET-but-absent `SQW_MODELS_JSON`, a project catalog superseding a global one, and custom models missing a
 * `cost` block. Empty when the catalog is clean or absent. Shared by `createModelRegistry` (which logs them at
 * review time) and `doctor` (which surfaces them at preflight, before any spend), so the set of guards lives in
 * one place. Reads env + fs via the same resolvers the registry uses. `cwd` scopes the *project* `models.json`
 * lookup — pass a repo root so `doctor -C <dir>` inspects that repo's catalog, not the process's cwd (#197).
 */
export function catalogWarnings(cwd: string = process.cwd()): string[] {
  const warnings: string[] = [];
  // A SET-but-absent SQW_MODELS_JSON silently loses its intended cost caps — check before resolving (which
  // can't tell that case apart from "unset", both collapsing to undefined).
  const missingOverride = missingOverrideWarning();
  if (missingOverride) {
    warnings.push(missingOverride);
  }
  const path = resolveModelsJsonPath(process.env, cwd);
  const globalPath = globalModelsJsonPath();
  const superseded = supersessionWarning(
    path,
    globalPath,
    existsSync(globalPath)
  );
  if (superseded) {
    warnings.push(superseded);
  }
  const missingCost = missingCostWarning(path);
  if (missingCost) {
    warnings.push(missingCost);
  }
  return warnings;
}

/**
 * Create a `ModelRegistry` for the project's catalog: resolves the `models.json` path and hands it to Pi, which
 * merges that file's models over the built-ins (custom wins). The caller keeps `authStorage` (it's reused for
 * the agent session). Logs the `catalogWarnings()` money/honesty guards at review time, and (a further guard)
 * warns when a malformed catalog falls back to built-ins rather than masquerading as "no custom models".
 */
export function createModelRegistry(authStorage: AuthStorage): ModelRegistry {
  for (const warning of catalogWarnings()) {
    console.warn(warning);
  }
  const path = resolveModelsJsonPath();
  const registry = ModelRegistry.create(authStorage, path);
  const error = registry.getError();
  if (error) {
    console.warn(
      `⚠️  models.json failed to load (${path}): ${error} — using built-in models only.`
    );
  }
  return registry;
}
