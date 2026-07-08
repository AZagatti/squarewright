import { expect, test } from "bun:test";
import { estimatePassSpend, makeSpendGuard } from "./spend-guard.js";

test("estimatePassSpend sums analysis + structurer tokens at their prices", () => {
  const usage = {
    analysisTokens: { input: 1000, output: 500 },
    structTokens: { input: 200, output: 100 },
  };
  const analysisPrice = { in: 0.001, out: 0.002 };
  const structPrice = { in: 0.0001, out: 0.0003 };

  // 1000*.001 + 500*.002 + 200*.0001 + 100*.0003 = 1 + 1 + 0.02 + 0.03 = 2.05
  expect(estimatePassSpend(usage, analysisPrice, structPrice)).toBeCloseTo(
    2.05,
    10
  );
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
  expect(guard.spent()).toBeCloseTo(0.5001, 10);
});
