import { expect, test } from "bun:test";
import type { ModelLane, ReviewContext } from "../core/types.js";
import type { WorkerRequest } from "./session.js";
import { buildAnalysisSystem } from "./worker.js";

const lane: ModelLane = { id: "x", model: "m", provider: "p", thinking: "off" };
const context = { files: [] } as unknown as ReviewContext;

function req(over: Partial<WorkerRequest>): WorkerRequest {
  return { context, lane, systemPrompt: "PERSONA", ...over };
}

test("buildAnalysisSystem: surveyor off/undefined omits the coverage-pass instruction (pure no-op)", () => {
  const base = buildAnalysisSystem(req({}));
  expect(base).not.toContain("coverage pass");
  expect(buildAnalysisSystem(req({ surveyor: false }))).toBe(base);
});

test("buildAnalysisSystem: surveyor on appends the same-call cross-file coverage instruction", () => {
  const s = buildAnalysisSystem(req({ surveyor: true }));
  expect(s).toContain("coverage pass");
  expect(s).toContain("EVERY other changed file");
  expect(s).toContain("same response"); // in-call, before concluding — not a second pass
});

test("buildAnalysisSystem: surveyor composes independently with rule-drift", () => {
  // surveyor present whether or not rule-drift is also on; drift on adds strictly more than surveyor alone.
  const both = buildAnalysisSystem(
    req({ proposeRuleDrift: true, surveyor: true })
  );
  const surveyorOnly = buildAnalysisSystem(req({ surveyor: true }));
  expect(both).toContain("coverage pass");
  expect(both.length).toBeGreaterThan(surveyorOnly.length);
});
