import { expect, test } from "bun:test";
import { INLINE_MARKER } from "../output/render.js";
import {
  CONFIDENCE_FLOOR,
  gateSuggestion,
  handleTeachReply,
  hasTeachTrigger,
  type ReplyInterpreter,
  type RuleSuggestion,
  renderRuleSuggestion,
  stripTrigger,
} from "./teach-reply.js";

/** A stub interpreter that records what it received and returns a fixed suggestion (or null). */
function stubInterpreter(
  returns: RuleSuggestion | null
): ReplyInterpreter & { calls: { findingText?: string; replyText: string }[] } {
  const calls: { findingText?: string; replyText: string }[] = [];
  return {
    calls,
    interpret: (input) => {
      calls.push(input);
      return Promise.resolve(returns);
    },
  };
}

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

test("gateSuggestion drops null, low-confidence, empty-rule, and empty-scope suggestions", () => {
  expect(gateSuggestion(null)).toBeNull();
  expect(
    gateSuggestion(sug({ confidence: CONFIDENCE_FLOOR - 0.01 }))
  ).toBeNull();
  expect(gateSuggestion(sug({ ruleText: "   " }))).toBeNull();
  expect(gateSuggestion(sug({ scope: "   " }))).toBeNull();
});

test("gateSuggestion drops a NaN / non-numeric confidence (must not bypass the floor via `NaN < FLOOR`)", () => {
  expect(gateSuggestion(sug({ confidence: Number.NaN }))).toBeNull();
  expect(
    gateSuggestion(sug({ confidence: "high" as unknown as number }))
  ).toBeNull();
  expect(
    gateSuggestion(sug({ confidence: Number.POSITIVE_INFINITY }))
  ).toBeNull();
  // a real above-floor confidence still passes
  expect(gateSuggestion(sug({ confidence: 0.9 }))).not.toBeNull();
});

test("teach trigger is intentionally loose — slash form fires without the keyword", () => {
  // documents nit: the `remember`/`rule` keyword is optional; the interpreter (Part B) is the real filter.
  expect(hasTeachTrigger("/squarewright hey look at this")).toBe(true);
  expect(stripTrigger("/squarewright hey look at this")).toBe(
    "hey look at this"
  );
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

const goodRule: RuleSuggestion = {
  confidence: 0.9,
  ruleText: "Validate req.body before db writes.",
  scope: "API handlers",
};

test("handleTeachReply: unauthorized reply never reaches the interpreter", async () => {
  const interp = stubInterpreter(goodRule);
  const out = await handleTeachReply({
    authorized: false,
    interpreter: interp,
    replyText: "@squarewright remember: validate input",
  });
  expect(out).toEqual({ kind: "skip", reason: "unauthorized" });
  expect(interp.calls).toHaveLength(0);
});

test("handleTeachReply: a non-trigger reply is skipped without calling the model", async () => {
  const interp = stubInterpreter(goodRule);
  const out = await handleTeachReply({
    authorized: true,
    interpreter: interp,
    replyText: "nice, thanks for the review",
  });
  expect(out).toEqual({ kind: "skip", reason: "no-trigger" });
  expect(interp.calls).toHaveLength(0);
});

test("handleTeachReply: strips the trigger before handing intent to the interpreter", async () => {
  const interp = stubInterpreter(goodRule);
  await handleTeachReply({
    authorized: true,
    findingText: "the finding",
    interpreter: interp,
    replyText: "@squarewright remember: no raw SQL",
  });
  expect(interp.calls[0]).toEqual({
    findingText: "the finding",
    replyText: "no raw SQL",
  });
});

test("handleTeachReply: a trigger with no content after it is skipped before the model", async () => {
  const interp = stubInterpreter(goodRule);
  const out = await handleTeachReply({
    authorized: true,
    interpreter: interp,
    replyText: "@squarewright   ",
  });
  expect(out).toEqual({ kind: "skip", reason: "empty-after-trigger" });
  expect(interp.calls).toHaveLength(0);
});

test("handleTeachReply: a low-confidence / no-rule reply is skipped (gate before render)", async () => {
  const out = await handleTeachReply({
    authorized: true,
    interpreter: stubInterpreter({ ...goodRule, confidence: 0.1 }),
    replyText: "@squarewright remember: maybe something",
  });
  expect(out).toEqual({ kind: "skip", reason: "no-durable-rule" });
});

test("handleTeachReply: a confident rule renders a post body", async () => {
  const out = await handleTeachReply({
    authorized: true,
    interpreter: stubInterpreter(goodRule),
    replyText: "@squarewright remember: validate req.body",
  });
  expect(out.kind).toBe("post");
  if (out.kind === "post") {
    expect(out.body).toContain(INLINE_MARKER);
    expect(out.body).toContain("Validate req.body before db writes.");
  }
});
