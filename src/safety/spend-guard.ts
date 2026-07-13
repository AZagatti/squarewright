/**
 * Shared local spend guard for paid (OpenRouter) model runs. Pi's `usage.cost` undercounts reasoning tokens and
 * the credits endpoint lags, so the reliable protection is an immediate token-based $ estimate accumulated per
 * pass and compared to a cap, plus a reasoning-trap classifier. One source for every spend-guarded caller: the
 * eval/judge/spike scripts and the product review path (`runReviewPost`'s trap preflight).
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
  // --max-time bounds a hung OpenRouter API: this runs on the product review path (the trap preflight), so a
  // stalled catalog fetch must not hang the whole review. On timeout/error curl exits non-zero → callers fail open.
  const out = execFileSync(
    "curl",
    ["-s", "--max-time", "15", "https://openrouter.ai/api/v1/models"],
    {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  return JSON.parse(out).data;
}

/**
 * Parse an OpenRouter model's `pricing` block into per-token prices — the pure core, split out for testing. Returns
 * `null` when EITHER field is absent or non-numeric: a `"0"` genuinely-free price parses to a finite 0 (a real
 * price), but `undefined`/malformed parses to `NaN`, which must not be silently coerced to a $0 that blinds the
 * spend guard. The caller turns `null` into a loud warn + $0 fallback (the fail-open-but-visible contract).
 */
export function parseOrPricing(
  pricing: { completion?: string; prompt?: string } | undefined
): TokenPrice | null {
  const inPrice = Number(pricing?.prompt);
  const outPrice = Number(pricing?.completion);
  if (!(Number.isFinite(inPrice) && Number.isFinite(outPrice))) {
    return null;
  }
  return { in: inPrice, out: outPrice };
}

/**
 * Per-token price for an OpenRouter model. Returns `{in:0,out:0}` for a model not found or on any error — a
 * price lookup failure must not block a run, so it fails open on price (the cap still applies once real prices
 * are known; a genuinely-free model is $0 anyway). Fail-open is deliberate but NOT silent: a fetch failure, an
 * unknown model, or a found model with malformed pricing means the token-based spend guard is effectively BLIND
 * (every pass estimates $0, so the circuit breaker can never trip), so we `console.warn` to stderr — the operator
 * must see the guard has no teeth this run.
 */
export function openrouterPrice(model: string): TokenPrice {
  try {
    const m = orModels().find((x) => x.id === model);
    if (!m) {
      console.warn(
        `⚠️  OpenRouter model "${model}" not in catalog — price defaulting to $0; the spend guard is BLIND for this model (its token cost estimates as $0, so --max-spend can't trip).`
      );
      return { in: 0, out: 0 };
    }
    const parsed = parseOrPricing(m.pricing);
    if (!parsed) {
      console.warn(
        `⚠️  OpenRouter model "${model}" has no parseable pricing (prompt=${m.pricing?.prompt}, completion=${m.pricing?.completion}) — price defaulting to $0; the spend guard is BLIND for this model (--max-spend can't trip on a $0 estimate).`
      );
      return { in: 0, out: 0 };
    }
    return parsed;
  } catch (e) {
    console.warn(
      `⚠️  OpenRouter price lookup for "${model}" failed (${e instanceof Error ? e.message : String(e)}) — price defaulting to $0; the spend guard is BLIND this run (token costs estimate as $0, so --max-spend can't trip). Watch the OpenRouter credits readout instead.`
    );
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
      // fail-open, but LOUD: a model absent from the catalog skips the reasoning-trap classifier, so a
      // mandatory-reasoning model could slip past the preflight and bill unbounded (the ~$5 trap this guards).
      console.warn(
        `⚠️  OpenRouter model "${model}" not in catalog — reasoning-trap preflight SKIPPED for it (proceeding unguarded; rely on --max-spend + the credits readout).`
      );
      return { block: false, detail: "model not found in OpenRouter catalog" };
    }
    return classifyReasoningRisk(m.reasoning as ReasoningMeta);
  } catch (e) {
    console.warn(
      `⚠️  OpenRouter reasoning-trap preflight failed (${e instanceof Error ? e.message : String(e)}) — proceeding WITHOUT the trap check; rely on --max-spend + the credits readout.`
    );
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
 * the one bug class the money rule (AGENTS.md §4) can't tolerate. Used by the eval/judge/spike scripts.
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
