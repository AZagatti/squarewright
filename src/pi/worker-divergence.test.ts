import { expect, test } from "bun:test";
import type { ModelLane, ReviewContext } from "../core/types.js";
import type { WorkerRequest } from "./session.js";
import { buildAnalysisSystem } from "./worker.js";

const lane: ModelLane = { id: "x", model: "m", provider: "p", thinking: "off" };
const context = { files: [] } as unknown as ReviewContext;

function req(over: Partial<WorkerRequest>): WorkerRequest {
  return { context, lane, systemPrompt: "PERSONA", ...over };
}

test("buildAnalysisSystem: divergence off/undefined omits the consistency instruction (pure no-op)", () => {
  const base = buildAnalysisSystem(req({}));
  expect(base).not.toContain("Consistency check");
  expect(base).not.toContain("cite the specific sibling");
  expect(buildAnalysisSystem(req({ divergence: false }))).toBe(base);
});

test("buildAnalysisSystem: divergence on appends a citation-forced, security/correctness-scoped instruction", () => {
  const s = buildAnalysisSystem(req({ divergence: true }));
  expect(s).toContain("Consistency check");
  // the two council-mandated narrowings must both be present in the prompt
  expect(s).toContain("security"); // scoped to safety-relevant divergences, not cosmetic style
  expect(s).toContain("cite the specific sibling"); // forced citation → checkable, not opinion
  expect(s).toContain("never report mere");
});

test("buildAnalysisSystem: divergence composes independently with the scaffold (both notes present)", () => {
  const both = buildAnalysisSystem(
    req({ cotScaffold: true, divergence: true })
  );
  const divergenceOnly = buildAnalysisSystem(req({ divergence: true }));
  expect(both).toContain("survived step 3"); // scaffold clause
  expect(both).toContain("Consistency check"); // divergence clause
  expect(both.length).toBeGreaterThan(divergenceOnly.length);
});
