/**
 * The default `.squarewright.yml` that `squarewright init` writes. Generated from `DEFAULT_PERSONAS` (the single
 * source of truth), so the scaffolded config carries the full review-persona set and can't drift from the code.
 * Review lanes run on z.ai's free `glm-5.2` (reasoning-off) — a provisional pre-v0.1 pick pending #49's
 * reproducible re-measure. The structurer runs on free `glm-5-turbo` (a mechanical pass-2 extractor). Point
 * "strong" at a frontier model for deeper reviews, or swap the provider entirely (Pi supports ~30).
 */
import { stringify } from "yaml";
import type { ModelLane } from "../core/types.js";
import { DEFAULT_PERSONAS } from "../personas/defaults.js";

const HEADER = `# Squarewright — reviewer assembly config, written by \`squarewright init\`.
# Edit freely: trim personas, retarget lanes (provider/model), tune budgets. The reviewer is model-agnostic.
# Review lanes use z.ai's free glm-5.2 (reasoning-off); the structurer uses free glm-5-turbo. Set the
# ZAI_API_KEY secret and you have a working reviewer. Point "strong" at a frontier model for deeper
# correctness/security review. See docs/adr/0001, docs/ROADMAP.md.
`;

function lane(id: string, model: string): ModelLane {
  return { id, model, provider: "zai", thinking: "off" };
}

/** Render the default assembly config as YAML — the personas come from `DEFAULT_PERSONAS`, never duplicated. */
export function renderDefaultConfig(): string {
  const config = {
    budget: { maxToolCalls: 30 },
    defaultLane: "cheap",
    feedback: { aggregate: false, enabled: true },
    grounders: [],
    lanes: [lane("strong", "glm-5.2"), lane("cheap", "glm-5.2")],
    personas: DEFAULT_PERSONAS,
    structurer: lane("structurer", "glm-5-turbo"),
  };
  return `${HEADER}\n${stringify(config)}`;
}
