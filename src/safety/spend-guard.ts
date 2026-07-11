/**
 * Shared local spend guard for paid (OpenRouter) model runs. Pi's `usage.cost` undercounts reasoning tokens and
 * the credits endpoint lags, so the reliable protection is an immediate token-based $ estimate accumulated per
 * pass and compared to a cap. The single source for every spend-guarded script (`eval.ts`, `spike.ts`, `judge.ts`).
 */
import { execFileSync } from "node:child_process";

/** Per-token price in USD (prompt vs completion). */
export interface TokenPrice {
  in: number;
  out: number;
}

/** Token usage from one worker pass (analysis + structurer), as returned in `WorkerResult.usage`. */
export interface PassUsage {
  analysisTokens?: { input: number; output: number };
  structTokens?: { input: number; output: number };
}

/** An OpenRouter model's `reasoning` metadata (from api/v1/models). */
export interface ReasoningMeta {
  default_effort?: string;
  mandatory?: boolean;
  supported_efforts?: string[];
}

function orModels(): Array<{
  id: string;
  pricing?: { completion?: string; prompt?: string };
  reasoning?: unknown;
}> {
  const out = execFileSync(
    "curl",
    ["-s", "https://openrouter.ai/api/v1/models"],
    {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  return JSON.parse(out).data;
}

/**
 * Per-token price for an OpenRouter model. Returns `{in:0,out:0}` for a model not found or on any error — a
 * price lookup failure must not block a run, so it fails open on price (the cap still applies once real prices
 * are known; a genuinely-free model is $0 anyway).
 */
export function openrouterPrice(model: string): TokenPrice {
  try {
    const m = orModels().find((x) => x.id === model);
    return {
      in: Number(m?.pricing?.prompt) || 0,
      out: Number(m?.pricing?.completion) || 0,
    };
  } catch {
    return { in: 0, out: 0 };
  }
}

/**
 * Classify whether a model's reasoning can be disabled cheaply — the pure decision, split out for testing. A
 * `mandatory` model, or one whose `supported_efforts` offer no cheap tier (none/minimal/low/medium), still bills
 * expensive reasoning tokens even at `off` (the ~$5 trap). `block: true` means "refuse at low/off effort".
 */
export function classifyReasoningRisk(
  reasoning: ReasoningMeta | null | undefined
): {
  block: boolean;
  detail: string;
} {
  if (!reasoning || typeof reasoning !== "object") {
    return { block: false, detail: "no reasoning (safe)" };
  }
  if (reasoning.mandatory) {
    return {
      block: true,
      detail: "reasoning.mandatory=true — reasoning cannot be disabled",
    };
  }
  const efforts = reasoning.supported_efforts ?? [];
  const cheap = efforts.some((e) =>
    ["none", "minimal", "low", "medium"].includes(e)
  );
  if (efforts.length > 0 && !cheap) {
    return {
      block: true,
      detail: `only supports efforts [${efforts.join(", ")}] (default ${reasoning.default_effort}) — 'off' falls back to expensive reasoning`,
    };
  }
  return { block: false, detail: "reasoning disableable at off (safe)" };
}

/**
 * Whether an OpenRouter model's reasoning can be disabled cheaply. Fetches the catalog and classifies; fails
 * open (never blocks) on a lookup error or unknown model. Inspect `supported_parameters`/`reasoning` at
 * api/v1/models to see the disable-ability directly.
 */
export function openrouterReasoningRisk(model: string): {
  block: boolean;
  detail: string;
} {
  try {
    const m = orModels().find((x) => x.id === model);
    if (!m) {
      return { block: false, detail: "model not found in OpenRouter catalog" };
    }
    return classifyReasoningRisk(m.reasoning as ReasoningMeta);
  } catch {
    return { block: false, detail: "reasoning-risk check failed (proceeding)" };
  }
}

/** Immediate $ estimate for one worker pass's token usage, given the analysis + structurer prices. */
export function estimatePassSpend(
  usage: PassUsage | undefined,
  analysisPrice: TokenPrice,
  structPrice: TokenPrice
): number {
  const a = usage?.analysisTokens ?? { input: 0, output: 0 };
  const s = usage?.structTokens ?? { input: 0, output: 0 };
  return (
    a.input * analysisPrice.in +
    a.output * analysisPrice.out +
    s.input * structPrice.in +
    s.output * structPrice.out
  );
}

export interface SpendGuard {
  /** accumulate an estimated spend (USD) */
  add: (usd: number) => void;
  /** total estimated spend so far (USD) */
  spent: () => number;
  /** has accumulated spend exceeded the cap? */
  tripped: () => boolean;
}

/** A running spend cap: accumulate estimated $ and report when it exceeds `maxSpend`. */
export function makeSpendGuard(maxSpend: number): SpendGuard {
  let spent = 0;
  return {
    add: (usd) => {
      spent += usd;
    },
    spent: () => spent,
    tripped: () => spent > maxSpend,
  };
}

/**
 * Parse a `--max-spend` flag value: `fallback` when the flag is absent, else a non-negative finite number.
 * Rejects a malformed value — a `NaN` cap makes `spent > NaN` always false, silently disabling the guard,
 * the one bug class the money rule (AGENTS.md §4) can't tolerate. Shared by every spend-guarded script.
 */
export function parseMaxSpend(
  raw: string | undefined,
  fallback: number
): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--max-spend must be a non-negative number (got "${raw}")`);
  }
  return n;
}
