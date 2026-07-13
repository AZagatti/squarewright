/**
 * `.squarewright.yml` — the Assembly config. Declarative: which provider/lanes, which personas, budgets,
 * routing. This is the "customize" height of the progressive-disclosure API (ADR-0001).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const thinkingLevel = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const modelLane = z.object({
  id: z.string(),
  model: z.string(),
  provider: z.string(),
  thinking: thinkingLevel.optional(),
});

const persona = z.object({
  // AC-conformance auditor: not glob-routed; runs as its own strong-lane pass only when the PR closes a fetched
  // issue (ReviewContext.linkedIssue), with the Worker's acCheck mode. See src/assembly/review.ts.
  acCheck: z.boolean().optional(),
  id: z.string(),
  label: z.string().optional(),
  lane: z.string(),
  needsCode: z.boolean().optional(),
  // explicit pass-group key: co-firing personas sharing a `pass` are batched into one Worker call (takes precedence over solo)
  pass: z.string().optional(),
  prompt: z.string(),
  solo: z.boolean().optional(),
  // reasoning depth for this lens; without it a tuned persona would silently run at "off" after config load
  thinking: thinkingLevel.optional(),
  when: z.array(z.string()).optional(),
});

export const assemblyConfigSchema = z.object({
  /** cost guardrails passed to the Worker */
  budget: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxToolCalls: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Tier-B background docs (ADR-0005 §1): existing freeform docs (AGENTS.md, docs/…) to inject as context when
   * the PR's changed files match `globs`. Read deterministically (zero-LLM) from the trusted base checkout and
   * injected below Tier-A `.review-rules` (which take precedence). Off unless configured.
   */
  contextDocs: z
    .array(z.object({ globs: z.array(z.string()), path: z.string() }))
    .optional(),
  /**
   * Prompted CoT scaffold: appends an UNDERSTAND → FIND → VERIFY(drop false positives) instruction to the analysis
   * prompt. A precision/recall TRADEOFF (eval/RESULTS.md, N=6): ~44% fewer false positives at a cost of ~1–1.5 loci
   * recall — so it's off by default (recall matters more on a reviewer that already misses most bugs) and stays an
   * opt-in lever for repos that prefer fewer false alarms. Distinct from native reasoning (which doesn't help this
   * classification-shaped task).
   */
  cotScaffold: z.boolean().default(false),
  /** default lane id when a persona doesn't specify one */
  defaultLane: z.string().optional(),
  /** local feedback loop toggles */
  feedback: z
    .object({
      /** opt-in anonymized aggregate telemetry — OFF by default (see docs/design/feedback-and-data.md) */
      aggregate: z.boolean().default(false),
      enabled: z.boolean().default(true),
    })
    .optional(),
  /** optional deterministic grounders (polyglot plugins, JSON contract) — off by default */
  grounders: z.array(z.string()).default([]),
  /** provider/model lanes available to personas */
  lanes: z.array(modelLane).min(1),
  /** review lenses */
  personas: z.array(persona).min(1),
  /**
   * The fixed pass-2 extractor lane (turns the analysis prose into structured findings). Optional; when
   * omitted the worker uses its built-in default (an OpenRouter model). Set this to a lane on your own provider
   * to avoid requiring an OpenRouter key — e.g. a z.ai model when your review lanes are z.ai.
   */
  structurer: modelLane.optional(),
});

export type AssemblyConfig = z.infer<typeof assemblyConfigSchema>;

export function parseAssemblyConfig(text: string): AssemblyConfig {
  const raw = parseYaml(text);
  return assemblyConfigSchema.parse(raw);
}

/** Load and validate `.squarewright.yml` from a repo root. */
export function loadAssemblyConfig(cwd: string): AssemblyConfig {
  const path = join(cwd, ".squarewright.yml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `No .squarewright.yml in ${cwd}. Run \`squarewright init\` to scaffold one.`,
      { cause: e }
    );
  }
  return parseAssemblyConfig(text);
}
