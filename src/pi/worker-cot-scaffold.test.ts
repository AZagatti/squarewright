import { expect, test } from "bun:test";
import type { ModelLane, ReviewContext } from "../core/types.js";
import type { WorkerRequest } from "./session.js";
import { buildAnalysisSystem } from "./worker.js";

const lane: ModelLane = { id: "x", model: "m", provider: "p", thinking: "off" };
const context = { files: [] } as unknown as ReviewContext;

function req(over: Partial<WorkerRequest>): WorkerRequest {
  return { context, lane, systemPrompt: "PERSONA", ...over };
}

test("buildAnalysisSystem: scaffold off/undefined omits the CoT-scaffold instruction (pure no-op)", () => {
  const base = buildAnalysisSystem(req({}));
  expect(base).not.toContain("UNDERSTAND");
  expect(base).not.toContain("survived step 3");
  expect(buildAnalysisSystem(req({ cotScaffold: false }))).toBe(base);
});

test("buildAnalysisSystem: scaffold on appends the explain -> find -> verify sequence", () => {
  const s = buildAnalysisSystem(req({ cotScaffold: true }));
  expect(s).toContain("UNDERSTAND");
  expect(s).toContain("FIND");
  expect(s).toContain("VERIFY");
  // the precision-critical clause: the final review keeps only VERIFY survivors
  expect(s).toContain("survived step 3");
});

test("buildAnalysisSystem: scaffold composes independently with surveyor (both notes present)", () => {
  // Documents the composition the production-risk council flagged as untested: scaffold's "keep only
  // survivors" and surveyor's "reopen and find more" both land in the prompt. This asserts they COEXIST
  // (no silent drop); whether they interact well is a measurement question, not a unit-test one.
  const both = buildAnalysisSystem(req({ cotScaffold: true, surveyor: true }));
  const scaffoldOnly = buildAnalysisSystem(req({ cotScaffold: true }));
  expect(both).toContain("survived step 3");
  expect(both).toContain("coverage pass");
  expect(both.length).toBeGreaterThan(scaffoldOnly.length);
});
