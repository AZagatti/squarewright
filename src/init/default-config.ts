/**
 * The default `.squarewright.yml` that `squarewright init` writes. Generated from `DEFAULT_PERSONAS` (the single
 * source of truth), so the scaffolded config carries the full review-persona set and can't drift from the code.
 * Review lanes run on z.ai's `glm-5.2` (reasoning-off) — a provisional pre-v0.1 pick pending #49's reproducible
 * re-measure; it needs a z.ai key (no permanent free tier for this model). The structurer runs on `glm-5-turbo`
 * (a mechanical pass-2 extractor). Point "strong" at a frontier model for deeper reviews, or swap the provider
 * entirely (Pi supports ~30).
 */
import { stringify } from "yaml";
import type { ModelLane } from "../core/types.js";
import { DEFAULT_PERSONAS } from "../personas/defaults.js";

const HEADER = `# Squarewright — reviewer assembly config, written by \`squarewright init\`.
# Edit freely: trim personas, retarget lanes (provider/model), tune budgets. The reviewer is model-agnostic.
# Review lanes use z.ai's glm-5.2 (reasoning-off); the structurer uses glm-5-turbo. Bring a model: set a
# ZAI_API_KEY secret — a z.ai API key (a paid Coding Plan or pay-as-you-go; there is no permanent free tier
# for glm-5.2) — and you have a working reviewer. The reviewer is model-agnostic: point "strong" at a frontier
# model, or retarget any lane at another of Pi's ~30 providers. See docs/adr/0001, docs/ROADMAP.md.
#
# OPT-IN: AC-conformance. To also check a PR against the acceptance criteria of the issue it Closes (flags a
# criterion silently left unmet), add an auditor persona and point it at a genuinely strong model — a free/small
# model is unreliable at the silent-vs-justified judgment (eval/RESULTS.md 2026-07-13). It runs only on PRs that
# link an issue. e.g. add to personas:
#   - id: auditor
#     label: Acceptance criteria
#     acCheck: true
#     lane: strong            # point "strong" at e.g. a Claude/GPT lane, not the free default
#     prompt: "You audit whether the PR satisfies the linked issue's acceptance criteria."
`;

function lane(id: string, model: string): ModelLane {
  return { id, model, provider: "zai", thinking: "off" };
}

/** Render the default assembly config as YAML — the personas come from `DEFAULT_PERSONAS`, never duplicated. */
export function renderDefaultConfig(): string {
  const config = {
    budget: { maxToolCalls: 30 },
    // Prompted CoT scaffold — a precision/recall TRADEOFF (eval/RESULTS.md, N=6): ~44% fewer false positives at a
    // cost of ~1–1.5 loci recall. Off by default (recall matters more on a reviewer that already misses most bugs);
    // set true to trade some recall + latency/tokens for fewer false alarms.
    cotScaffold: false,
    defaultLane: "cheap",
    feedback: { aggregate: false, enabled: true },
    grounders: [],
    lanes: [lane("strong", "glm-5.2"), lane("cheap", "glm-5.2")],
    personas: DEFAULT_PERSONAS,
    structurer: lane("structurer", "glm-5-turbo"),
  };
  return `${HEADER}\n${stringify(config)}`;
}
