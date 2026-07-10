import { expect, test } from "bun:test";
import type { Finding } from "../core/types.js";
import { aggregateFindings } from "./aggregate.js";

const f = (over: Partial<Finding>): Finding => ({
  line: 10,
  message: "unvalidated request body passed to db.insert",
  path: "src/api/users.ts",
  rule: "persona:security",
  severity: "warning",
  source: "persona:security",
  ...over,
});

test("same-issue findings collapse and bump consensus", () => {
  const out = aggregateFindings([
    f({ source: "persona:a" }),
    f({ line: 11, source: "persona:b" }),
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]?.consensus).toBe(2);
  expect(out[0]?.sources).toEqual(["persona:a", "persona:b"]);
});

test("a rule-drift proposal survives collapse into a plain finding that landed first", () => {
  // persona:a raises a plain finding; persona:b independently raises the same issue WITH a rule-drift proposal.
  // The proposal must be carried onto the merged survivor, not dropped.
  const out = aggregateFindings([
    f({ source: "persona:a" }),
    f({
      line: 12,
      proposedRule: "```md\n---\ndescription: x\n---\nrule\n```",
      source: "persona:b",
    }),
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]?.proposedRule).toContain("description: x");
});

test("an existing proposal is not overwritten by a later duplicate's proposal", () => {
  const out = aggregateFindings([
    f({ proposedRule: "FIRST", source: "persona:a" }),
    f({ line: 12, proposedRule: "SECOND", source: "persona:b" }),
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]?.proposedRule).toBe("FIRST");
});

test("distinct issues are not merged", () => {
  const out = aggregateFindings([
    f({}),
    f({ message: "missing null check on user.id", path: "src/other.ts" }),
  ]);
  expect(out).toHaveLength(2);
});
