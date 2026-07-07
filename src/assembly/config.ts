/**
 * `.squarewright.yml` — the Assembly config. Declarative: which provider/lanes, which personas, budgets,
 * routing. This is the "customize" height of the progressive-disclosure API (ADR-0001).
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const modelLane = z.object({
  id: z.string(),
  model: z.string(),
  provider: z.string(),
  thinking: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
    .optional(),
});

const persona = z.object({
  id: z.string(),
  lane: z.string(),
  needsCode: z.boolean().optional(),
  prompt: z.string(),
  solo: z.boolean().optional(),
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
});

export type AssemblyConfig = z.infer<typeof assemblyConfigSchema>;

export function parseAssemblyConfig(text: string): AssemblyConfig {
  const raw = parseYaml(text);
  return assemblyConfigSchema.parse(raw);
}
