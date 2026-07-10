import { describe, expect, test } from "bun:test";
import {
  detectRuleFinding,
  type ProbeFinding,
  type RuleTarget,
  toProbeFindings,
} from "./rules-probe.js";

const TARGET: RuleTarget = {
  keywords: ["clock.ts", "Date.now", "deterministic replay"],
  line: 2,
  path: "src/session/expiry.ts",
};

describe("detectRuleFinding", () => {
  test("detects a finding on the target line whose text mentions a keyword", () => {
    const findings: ProbeFinding[] = [
      {
        line: 2,
        path: "src/session/expiry.ts",
        text: "Direct Date.now() call breaks the deterministic replay engine.",
      },
    ];
    expect(detectRuleFinding(findings, TARGET)).toBe(true);
  });

  test("within the line tolerance still counts (diff line numbers are approximate)", () => {
    const findings: ProbeFinding[] = [
      { line: 4, path: "src/session/expiry.ts", text: "must use clock.ts" },
    ];
    expect(detectRuleFinding(findings, TARGET)).toBe(true); // |4-2| = 2 <= 3
  });

  test("a finding on the right file but a different topic does NOT count", () => {
    const findings: ProbeFinding[] = [
      {
        line: 2,
        path: "src/session/expiry.ts",
        text: "Off-by-one: `>` should be `>=` for expiry.",
      },
    ];
    expect(detectRuleFinding(findings, TARGET)).toBe(false);
  });

  test("a finding on the wrong file does NOT count", () => {
    const findings: ProbeFinding[] = [
      { line: 2, path: "src/other.ts", text: "uses Date.now directly" },
    ];
    expect(detectRuleFinding(findings, TARGET)).toBe(false);
  });

  test("a finding too far from the target line does NOT count", () => {
    const findings: ProbeFinding[] = [
      { line: 20, path: "src/session/expiry.ts", text: "uses Date.now" },
    ];
    expect(detectRuleFinding(findings, TARGET)).toBe(false);
  });

  test("no findings → not flagged", () => {
    expect(detectRuleFinding([], TARGET)).toBe(false);
  });
});

describe("toProbeFindings", () => {
  test("flattens inline (body) and unplaceable (message) into path/line/text", () => {
    const out = toProbeFindings({
      inline: [{ body: "B", line: 1, path: "a.ts" }],
      unplaceable: [{ line: 9, message: "M", path: "b.ts" }],
    });
    expect(out).toEqual([
      { line: 1, path: "a.ts", text: "B" },
      { line: 9, path: "b.ts", text: "M" },
    ]);
  });

  test("tolerates missing arrays", () => {
    expect(toProbeFindings({})).toEqual([]);
  });
});
