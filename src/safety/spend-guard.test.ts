import { expect, test } from "bun:test";
import {
  classifyReasoningRisk,
  estimatePassSpend,
  makeSpendGuard,
  parseMaxSpend,
  parseOrPricing,
} from "./spend-guard.js";

test("parseMaxSpend: uses the fallback when the flag is absent", () => {
  expect(parseMaxSpend(undefined, 0.5)).toBe(0.5);
});

test("parseMaxSpend: parses a valid non-negative number (including 0)", () => {
  expect(parseMaxSpend("0.1", 0.5)).toBe(0.1);
  expect(parseMaxSpend("0", 0.5)).toBe(0);
});

test("parseMaxSpend: rejects a malformed value instead of silently disabling the cap", () => {
  // NaN would make `spent > NaN` always false — the guard would never trip.
  expect(() => parseMaxSpend("$0.5", 0.5)).toThrow("non-negative number");
  expect(() => parseMaxSpend("abc", 0.5)).toThrow();
  expect(() => parseMaxSpend("-1", 0.5)).toThrow();
});

test("estimatePassSpend sums analysis + structurer tokens at their prices", () => {
  const usage = {
    analysisTokens: { input: 1000, output: 500 },
    structTokens: { input: 200, output: 100 },
  };
  // 1000*.001 + 500*.002 + 200*.0001 + 100*.0003 = 1 + 1 + 0.02 + 0.03 = 2.05
  expect(
    estimatePassSpend(
      usage,
      { in: 0.001, out: 0.002 },
      { in: 0.0001, out: 0.0003 }
    )
  ).toBeCloseTo(2.05, 10);
});

test("estimatePassSpend is zero for missing usage or zero prices", () => {
  const zero = { in: 0, out: 0 };
  expect(estimatePassSpend(undefined, zero, zero)).toBe(0);
  expect(
    estimatePassSpend(
      { analysisTokens: { input: 1e6, output: 1e6 } },
      zero,
      zero
    )
  ).toBe(0);
});

test("makeSpendGuard trips only once accumulated spend exceeds the cap", () => {
  const guard = makeSpendGuard(0.5);

  guard.add(0.3);
  expect(guard.tripped()).toBe(false);
  guard.add(0.2);
  // 0.5 is at the cap, not over
  expect(guard.spent()).toBeCloseTo(0.5, 10);
  expect(guard.tripped()).toBe(false);

  guard.add(0.0001);
  expect(guard.tripped()).toBe(true);
});

test("parseOrPricing: a genuinely-free model ($0 price) parses to a real 0, not blind", () => {
  // "0" is a real price the guard can trust — must NOT collapse to the null/blind case.
  expect(parseOrPricing({ completion: "0", prompt: "0" })).toEqual({
    in: 0,
    out: 0,
  });
});

test("parseOrPricing: valid numeric-string prices parse through", () => {
  expect(
    parseOrPricing({ completion: "0.000002", prompt: "0.000001" })
  ).toEqual({ in: 0.000_001, out: 0.000_002 });
});

test("parseOrPricing: absent or malformed pricing is null (guard is blind, not free)", () => {
  expect(parseOrPricing(undefined)).toBeNull();
  expect(parseOrPricing({})).toBeNull(); // both fields missing
  expect(parseOrPricing({ prompt: "0.001" })).toBeNull(); // completion missing
  expect(parseOrPricing({ completion: "0.001" })).toBeNull(); // prompt missing
  expect(parseOrPricing({ completion: "x", prompt: "0.001" })).toBeNull(); // non-numeric
});

test("classifyReasoningRisk: no reasoning metadata is safe", () => {
  expect(classifyReasoningRisk(undefined).block).toBe(false);
  expect(classifyReasoningRisk(null).block).toBe(false);
  expect(classifyReasoningRisk({}).block).toBe(false);
});

test("classifyReasoningRisk: mandatory reasoning is blocked", () => {
  const r = classifyReasoningRisk({ mandatory: true });
  expect(r.block).toBe(true);
  expect(r.detail).toContain("mandatory");
});

test("classifyReasoningRisk: only high/xhigh efforts is blocked (no cheap tier)", () => {
  const r = classifyReasoningRisk({ supported_efforts: ["high", "xhigh"] });
  expect(r.block).toBe(true);
  expect(r.detail).toContain("high");
});

test("classifyReasoningRisk: a cheap effort (low/none) is safe", () => {
  expect(
    classifyReasoningRisk({ supported_efforts: ["none", "low", "high"] }).block
  ).toBe(false);
  expect(
    classifyReasoningRisk({ supported_efforts: ["medium", "high"] }).block
  ).toBe(false);
});
