import { expect, test } from "bun:test";
import { analysisMentionsLocus, sameFile } from "./locus-match.js";

test("sameFile matches on exact, suffix, and basename", () => {
  expect(sameFile("src/auth/session.ts", "src/auth/session.ts")).toBe(true);
  expect(sameFile("a/b/src/auth/session.ts", "src/auth/session.ts")).toBe(true);
  expect(sameFile("session.ts", "src/auth/session.ts")).toBe(true); // basename rule
  expect(sameFile("src/auth/other.ts", "src/auth/session.ts")).toBe(false);
});

test("analysisMentionsLocus finds a locus named anywhere in the prose", () => {
  const prose =
    "The bug is in src/auth/session.ts around line 42 — the token isn't cleared.";
  expect(analysisMentionsLocus(prose, "src/auth/session.ts")).toBe(true);
  // basename-only mention still counts (mirrors sameFile's looseness)
  expect(
    analysisMentionsLocus(
      "Look at session.ts near the top",
      "src/auth/session.ts"
    )
  ).toBe(true);
});

test("analysisMentionsLocus reuses sameFile — colon/line-suffix forms still match", () => {
  // the analysis often writes `path:line`; the path token is extracted and sameFile-matched
  expect(
    analysisMentionsLocus(
      "see src/pi/worker.ts:517 for the leak",
      "src/pi/worker.ts"
    )
  ).toBe(true);
});

test("analysisMentionsLocus is negative when the file is never named", () => {
  expect(
    analysisMentionsLocus(
      "There is a general concurrency problem but I can't localize it.",
      "src/auth/session.ts"
    )
  ).toBe(false);
  // a DIFFERENT file with a different basename does not count
  expect(
    analysisMentionsLocus(
      "The issue is in src/auth/login.ts",
      "src/auth/session.ts"
    )
  ).toBe(false);
});

test("analysisMentionsLocus: the structurer-drop gap it is designed to expose", () => {
  // A capable analysis NAMES the locus in prose; if the structurer later drops it, structured recall (sameFile
  // over findings) would score 0 while analysis recall scores 1 — that 1-vs-0 gap is the #78 confound.
  const analysis = "Real defect: race in src/queue/worker.ts, unbounded retry.";
  const structuredFindingsThatDroppedIt: string[] = []; // structurer emitted nothing
  const locus = "src/queue/worker.ts";
  expect(analysisMentionsLocus(analysis, locus)).toBe(true);
  expect(structuredFindingsThatDroppedIt.some((p) => sameFile(p, locus))).toBe(
    false
  );
});
