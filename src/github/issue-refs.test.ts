import { expect, test } from "bun:test";
import { parseIssueRefs } from "./issue-refs.js";

test("parseIssueRefs: extracts a single closing reference", () => {
  expect(parseIssueRefs("Closes #123")).toEqual([123]);
});

test("parseIssueRefs: all keyword forms, case-insensitive", () => {
  expect(parseIssueRefs("closes #1, Fixes #2, RESOLVED #3")).toEqual([1, 2, 3]);
  expect(parseIssueRefs("close #4 fixed #5 resolve #6")).toEqual([4, 5, 6]);
});

test("parseIssueRefs: tolerates a colon and de-dupes in first-seen order", () => {
  expect(parseIssueRefs("Fixes: #7\n\nAlso Closes #7 and closes #4")).toEqual([
    7, 4,
  ]);
});

test("parseIssueRefs: ignores a bare #ref with no closing keyword", () => {
  expect(parseIssueRefs("See #42 for context; part of #43")).toEqual([]);
});

test("parseIssueRefs: does not match a keyword embedded in a larger word", () => {
  // "discloses" contains "closes" but must not match (\b guard); "prefixes" contains "fixes"
  expect(parseIssueRefs("This discloses #9 and prefixes #10 nothing")).toEqual(
    []
  );
});

test("parseIssueRefs: empty / null / undefined body → []", () => {
  expect(parseIssueRefs("")).toEqual([]);
  expect(parseIssueRefs(null)).toEqual([]);
  expect(parseIssueRefs(undefined)).toEqual([]);
});

test("parseIssueRefs: keyword without an adjacent #number does not match", () => {
  expect(parseIssueRefs("This fixes the bug described in the ticket.")).toEqual(
    []
  );
});
