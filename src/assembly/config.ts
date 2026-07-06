/**
 * `.squarewright.yml` — the Assembly config. Declarative: which provider/lanes, which personas, budgets,
 * routing. This is the "customize" height of the progressive-disclosure API (ADR-0001).
 */
import { z } from "zod";
import { parse as parseYaml } from "yaml";

const modelLane = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
});

const persona = z.object({
  id: z.string(),
  lane: z.string(),
  when: z.array(z.string()).optional(),
  needsCode: z.boolean().optional(),
  solo: z.boolean().optional(),
  prompt: z.string(),
});

export const assemblyConfigSchema = z.object({
  /** provider/model lanes available to personas */
  lanes: z.array(modelLane).min(1),
  /** default lane id when a persona doesn't specify one */
  defaultLane: z.string().optional(),
  /** review lenses */
  personas: z.array(persona).min(1),
  /** optional deterministic grounders (polyglot plugins, JSON contract) — off by default */
  grounders: z.array(z.string()).default([]),
  /** cost guardrails passed to the Worker */
  budget: z
    .object({
      maxToolCalls: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
  /** local feedback loop toggles */
  feedback: z
    .object({
      enabled: z.boolean().default(true),
      /** opt-in anonymized aggregate telemetry — OFF by default (see docs/design/feedback-and-data.md) */
      aggregate: z.boolean().default(false),
    })
    .optional(),
});

export type AssemblyConfig = z.infer<typeof assemblyConfigSchema>;

export function parseAssemblyConfig(text: string): AssemblyConfig {
  const raw = parseYaml(text);
  return assemblyConfigSchema.parse(raw);
}
