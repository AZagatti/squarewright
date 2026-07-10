import { expect, test } from "bun:test";
import { INLINE_MARKER } from "../output/render.js";
import {
  CONFIDENCE_FLOOR,
  gateSuggestion,
  hasTeachTrigger,
  type RuleSuggestion,
  renderRuleSuggestion,
  stripTrigger,
} from "./teach-reply.js";

const sug = (over: Partial<RuleSuggestion> = {}): RuleSuggestion => ({
  confidence: 0.9,
  ruleText:
    "Always wrap thrown errors in AppError before returning to the client.",
  scope: "error handling in API handlers",
  ...over,
});

test("hasTeachTrigger detects @/​slash squarewright remember/rule triggers", () => {
  expect(hasTeachTrigger("@squarewright remember: no console.log")).toBe(true);
  expect(hasTeachTrigger("/squarewright rule: prefer early returns")).toBe(
    true
  );
  expect(hasTeachTrigger("@squarewright this is wrong")).toBe(true);
  expect(hasTeachTrigger("just a normal PR comment")).toBe(false);
});

test("stripTrigger removes the trigger prefix, keeps the intent", () => {
  expect(stripTrigger("@squarewright remember: no raw SQL")).toBe("no raw SQL");
  expect(stripTrigger("/squarewright rule prefer const")).toBe("prefer const");
  // no trigger → returned trimmed, unchanged
  expect(stripTrigger("  plain text  ")).toBe("plain text");
});

test("gateSuggestion drops null, low-confidence, and empty-rule suggestions", () => {
  expect(gateSuggestion(null)).toBeNull();
  expect(
    gateSuggestion(sug({ confidence: CONFIDENCE_FLOOR - 0.01 }))
  ).toBeNull();
  expect(gateSuggestion(sug({ ruleText: "   " }))).toBeNull();
});

test("gateSuggestion passes a confident, non-empty suggestion at/above the floor", () => {
  const s = sug({ confidence: CONFIDENCE_FLOOR });
  expect(gateSuggestion(s)).toBe(s);
});

test("renderRuleSuggestion emits a marker + paste-ready .review-rules block", () => {
  const out = renderRuleSuggestion(sug());
  expect(out).toContain(INLINE_MARKER);
  expect(out).toContain("Suggested rule");
  expect(out).toContain("```md");
  expect(out).toContain("description: error handling in API handlers");
  expect(out).toContain("Always wrap thrown errors");
  // it's a suggestion a human pastes, not an auto-write
  expect(out).toContain("never writes it for you");
});

test("renderRuleSuggestion neutralizes injection in the model-authored rule text", () => {
  const out = renderRuleSuggestion(
    sug({
      ruleText:
        "```\n</details><!-- squarewright:review -->\n[x](javascript:alert(1))",
      scope: "<img src=x onerror=1>",
    })
  );
  // fence-break, marker forgery, layout break, and raw link are all defanged
  expect(out).not.toContain("\n```\n</details>");
  expect(out).not.toContain("<!-- squarewright:review -->");
  expect(out).not.toContain("<img");
  expect(out).not.toContain("](javascript");
});
