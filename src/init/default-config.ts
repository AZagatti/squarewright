/**
 * The default `.squarewright.yml` that `squarewright init` writes. Generated from `DEFAULT_PERSONAS` (the single
 * source of truth), so the scaffolded config carries the full review-persona set and can't drift from the code.
 * Lanes default to z.ai's free `glm-5-turbo` (the value pick) — a working reviewer with only a z.ai key; point
 * "strong" at a frontier model for deeper reviews, or swap the provider entirely (Pi supports ~30).
 */
import { stringify } from "yaml";
import type { ModelLane } from "../core/types.js";
import { DEFAULT_PERSONAS } from "../personas/defaults.js";

const HEADER = `# Squarewright — reviewer assembly config, written by \`squarewright init\`.
# Edit freely: trim personas, retarget lanes (provider/model), tune budgets. The reviewer is model-agnostic.
# Lanes default to z.ai's free glm-5-turbo; set the ZAI_API_KEY secret and you have a working reviewer.
# Point "strong" at a frontier model for deeper correctness/security review. See docs/adr/0001, docs/ROADMAP.md.
`;

function lane(id: string): ModelLane {
  return { id, model: "glm-5-turbo", provider: "zai", thinking: "off" };
}

/** Render the default assembly config as YAML — the personas come from `DEFAULT_PERSONAS`, never duplicated. */
export function renderDefaultConfig(): string {
  const config = {
    budget: { maxToolCalls: 30 },
    defaultLane: "cheap",
    feedback: { aggregate: false, enabled: true },
    grounders: [],
    lanes: [lane("strong"), lane("cheap")],
    personas: DEFAULT_PERSONAS,
    structurer: lane("structurer"),
  };
  return `${HEADER}\n${stringify(config)}`;
}
