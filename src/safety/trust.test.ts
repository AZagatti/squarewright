import { describe, expect, test } from "bun:test";
import {
  type ClaimedTarget,
  isAuthorizedTeachActor,
  type LookupPullsForCommit,
  type TrustedRunSignal,
  TrustViolation,
  verifyPostingTarget,
} from "./trust.js";

const TRUSTED: TrustedRunSignal = {
  baseRepo: "o/r",
  headSha: "cafe1234",
};

const CLAIMED: ClaimedTarget = {
  headSha: "cafe1234",
  prNumber: 7,
  repo: "o/r",
};

/** A lookup that always resolves the commit to the given PR numbers, and records how it was called. */
function lookupReturning(numbers: number[]): {
  fn: LookupPullsForCommit;
  calls: { repo: string; sha: string }[];
} {
  const calls: { repo: string; sha: string }[] = [];
  const fn: LookupPullsForCommit = (repo, sha) => {
    calls.push({ repo, sha });
    return Promise.resolve(numbers.map((number) => ({ number })));
  };
  return { calls, fn };
}

describe("verifyPostingTarget", () => {
  test("builds the target from trusted signals when everything agrees", async () => {
    const { fn, calls } = lookupReturning([7]);

    const target = await verifyPostingTarget(CLAIMED, TRUSTED, fn);

    expect(target).toEqual({ commitSha: "cafe1234", prNumber: 7, repo: "o/r" });
    // the lookup is authenticated against the TRUSTED repo+sha, never the claim
    expect(calls).toEqual([{ repo: "o/r", sha: "cafe1234" }]);
  });

  test("rejects a head-SHA mismatch before any lookup", async () => {
    const { fn, calls } = lookupReturning([7]);
    const poisoned: ClaimedTarget = { ...CLAIMED, headSha: "deadbeef" };

    await expect(verifyPostingTarget(poisoned, TRUSTED, fn)).rejects.toThrow(
      TrustViolation
    );
    expect(calls).toEqual([]);
  });

  test("rejects a repo mismatch before any lookup", async () => {
    const { fn, calls } = lookupReturning([7]);
    const poisoned: ClaimedTarget = { ...CLAIMED, repo: "evil/elsewhere" };

    await expect(verifyPostingTarget(poisoned, TRUSTED, fn)).rejects.toThrow(
      TrustViolation
    );
    expect(calls).toEqual([]);
  });

  test("returns null (benign no-op, NOT a violation) when the commit has zero open PRs", async () => {
    // The PR was merged/closed between gather and review — nothing to post, nothing suspicious. Must resolve to
    // null (the caller no-ops and exits clean), NOT throw a TrustViolation (which would paint the workflow red).
    const { fn } = lookupReturning([]);
    await expect(verifyPostingTarget(CLAIMED, TRUSTED, fn)).resolves.toBeNull();
  });

  test("still refuses (TrustViolation) when the commit resolves to more than one open PR", async () => {
    const { fn } = lookupReturning([7, 8]);

    const { rejects } = expect(verifyPostingTarget(CLAIMED, TRUSTED, fn));
    await rejects.toThrow(TrustViolation);
    await rejects.toThrow("found 2");
  });

  test("refuses when the derived PR number disagrees with the artifact's claim", async () => {
    const { fn } = lookupReturning([99]);

    await expect(verifyPostingTarget(CLAIMED, TRUSTED, fn)).rejects.toThrow(
      TrustViolation
    );
  });
});

describe("isAuthorizedTeachActor", () => {
  const ok = {
    actorLogin: "maintainer",
    association: "MEMBER",
    permission: "write",
    prAuthorLogin: "contributor",
  };
  test("authorizes a write-permission member who is not the PR author", () => {
    expect(isAuthorizedTeachActor(ok)).toBe(true);
    expect(isAuthorizedTeachActor({ ...ok, permission: "admin" })).toBe(true);
    expect(isAuthorizedTeachActor({ ...ok, permission: "maintain" })).toBe(
      true
    );
  });
  test("rejects read/none permission even with a good association", () => {
    expect(isAuthorizedTeachActor({ ...ok, permission: "read" })).toBe(false);
    expect(isAuthorizedTeachActor({ ...ok, permission: "none" })).toBe(false);
  });
  test("rejects a non-teaching association even with write permission", () => {
    expect(isAuthorizedTeachActor({ ...ok, association: "CONTRIBUTOR" })).toBe(
      false
    );
    expect(isAuthorizedTeachActor({ ...ok, association: "NONE" })).toBe(false);
  });
  test("excludes the PR author teaching on their own PR", () => {
    expect(isAuthorizedTeachActor({ ...ok, actorLogin: "contributor" })).toBe(
      false
    );
  });
  test("author-exclusion is case-insensitive (GitHub logins are)", () => {
    // "Contributor" and "contributor" are the same GitHub account — a case-only difference between the two
    // payloads must not let the PR author teach on their own PR.
    expect(
      isAuthorizedTeachActor({
        ...ok,
        actorLogin: "Contributor",
        prAuthorLogin: "contributor",
      })
    ).toBe(false);
    expect(
      isAuthorizedTeachActor({
        ...ok,
        actorLogin: "contributor",
        prAuthorLogin: "CONTRIBUTOR",
      })
    ).toBe(false);
  });
  test("fails closed when actor or PR-author login is missing (lookup failure)", () => {
    // an unknown PR author (e.g. the workflow's author lookup failed) must NOT silently disable the exclusion
    expect(isAuthorizedTeachActor({ ...ok, prAuthorLogin: "" })).toBe(false);
    expect(isAuthorizedTeachActor({ ...ok, actorLogin: "" })).toBe(false);
  });
});
