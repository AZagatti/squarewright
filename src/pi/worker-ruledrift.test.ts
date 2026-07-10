import { expect, test } from "bun:test";
import type { Finding } from "../core/types.js";
import {
  buildFindingsSchema,
  buildStructurerSystem,
  capRuleDrift,
  submittedToFinding,
} from "./worker.js";

const base = {
  detail: "reason",
  line: 3,
  path: "src/a.ts",
  severity: "warning" as const,
  title: "issue",
};

test("submittedToFinding carries proposedRule through when present", () => {
  const f = submittedToFinding(
    { ...base, proposedRule: "```md\n# rule\n```" },
    "persona:security"
  );
  expect(f.proposedRule).toBe("```md\n# rule\n```");
  expect(f.rule).toBe("persona:security");
  expect(f.source).toBe("persona:security");
  expect(f.message).toBe("issue — reason");
});

test("submittedToFinding leaves proposedRule undefined when absent or blank", () => {
  expect(submittedToFinding(base, "p").proposedRule).toBeUndefined();
  expect(
    submittedToFinding({ ...base, proposedRule: "   " }, "p").proposedRule
  ).toBeUndefined();
});

test("submittedToFinding HARD-drops proposedRule when allowRuleDrift is false", () => {
  // Even if the model freelances the key (schema is non-strict), an opted-out repo never gets a proposal.
  const f = submittedToFinding(
    { ...base, proposedRule: "```md\nrule\n```" },
    "p",
    false
  );
  expect(f.proposedRule).toBeUndefined();
});

test("Pass-2 gating: structurer prompt + schema only offer proposedRule when enabled", () => {
  // ON: the structurer is told to carry a proposal, and the schema advertises the field.
  expect(buildStructurerSystem(true)).toContain("proposedRule");
  expect(JSON.stringify(buildFindingsSchema(true))).toContain("proposedRule");
  // OFF: neither mentions it — a repo that opted out cannot have a stray fenced block extracted.
  expect(buildStructurerSystem(false)).not.toContain("proposedRule");
  expect(buildStructurerSystem(false)).not.toContain("rule-drift");
  expect(JSON.stringify(buildFindingsSchema(false))).not.toContain(
    "proposedRule"
  );
});

test("capRuleDrift keeps the FIRST proposal and strips the rest (≤1 per pass)", () => {
  const findings: Finding[] = [
    { ...base, message: "a", proposedRule: "first", rule: "p", source: "p" },
    { ...base, message: "b", proposedRule: "second", rule: "p", source: "p" },
    { ...base, message: "c", proposedRule: "third", rule: "p", source: "p" },
  ];
  const out = capRuleDrift(findings);
  expect(out.map((f) => f.proposedRule)).toEqual([
    "first",
    undefined,
    undefined,
  ]);
  // non-proposal fields are untouched
  expect(out.map((f) => f.message)).toEqual(["a", "b", "c"]);
});

test("capRuleDrift is a no-op when at most one finding proposes a rule", () => {
  const findings: Finding[] = [
    { ...base, message: "a", rule: "p", source: "p" },
    { ...base, message: "b", proposedRule: "only", rule: "p", source: "p" },
  ];
  expect(capRuleDrift(findings)).toEqual(findings);
});

test("capRuleDrift preserves the proposal even when it is not the first finding", () => {
  const findings: Finding[] = [
    { ...base, message: "plain", rule: "p", source: "p" },
    { ...base, message: "drift", proposedRule: "R", rule: "p", source: "p" },
    { ...base, message: "also", proposedRule: "R2", rule: "p", source: "p" },
  ];
  const out = capRuleDrift(findings);
  expect(out[1]?.proposedRule).toBe("R");
  expect(out[2]?.proposedRule).toBeUndefined();
});
