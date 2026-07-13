/**
 * The artifact trust check — the trusted review phase's gate before any GitHub write. The gather phase runs on
 * `pull_request` in the PR's own (untrusted) context, so every field of its artifact is attacker-controlled: a
 * fork PR can rewrite the gather workflow and forge `pr-meta.json`. This module never derives a posting target
 * from those claims. The only legal target is built from the trusted `workflow_run` signals GitHub itself sets
 * (the head SHA and the base repo the review workflow runs in), with the PR number derived by an authenticated
 * lookup against that trusted repo+SHA — the event's `pull_requests` is empty for fork PRs, so it can't supply
 * one. The artifact's claims are cross-checked and must agree; any disagreement is a `TrustViolation` and
 * nothing is posted (fail closed).
 */
import type { ReviewContext } from "../core/types.js";

/** The artifact's self-reported identity — untrusted; used only to cross-check, never as a source of truth. */
export type ClaimedTarget = Pick<
  ReviewContext,
  "headSha" | "prNumber" | "repo"
>;

/** Signals GitHub sets on the `workflow_run` event; trusted because the review workflow runs from the base repo. */
export interface TrustedRunSignal {
  /** `github.event.workflow_run.repository.full_name` — the base repo the review workflow runs in */
  baseRepo: string;
  /** `github.event.workflow_run.head_sha` */
  headSha: string;
}

/** The single legal posting location, built only from trusted signals. */
export interface VerifiedTarget {
  commitSha: string;
  prNumber: number;
  repo: string;
}

/**
 * Open PRs in `repo` whose head commit is `sha`. Authenticated against the TRUSTED repo+sha (never the
 * artifact's claims). The implementation must return only OPEN pull requests.
 */
export type LookupPullsForCommit = (
  repo: string,
  sha: string
) => Promise<{ number: number }[]>;

/** A cross-check failed: the artifact disagrees with the trusted signals, or the PR number is unresolvable. */
export class TrustViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustViolation";
  }
}

/**
 * Resolve the one posting target the review is allowed to write to. Throws `TrustViolation` — refusing to post —
 * on any real mismatch between the untrusted artifact and the trusted run (SHA, repo, or a disagreeing PR number),
 * or on the ambiguous case of MORE than one open PR sharing the head commit. Returns `null` for the BENIGN case of
 * ZERO open PRs: the PR was merged or closed between gather and review (a common race when the review posts
 * asynchronously) — there is nothing to post to and nothing suspicious about it (an attacker cannot benefit from
 * posting nowhere), so the caller no-ops and exits cleanly rather than reporting a failure. The returned target is
 * composed entirely from trusted inputs.
 */
export async function verifyPostingTarget(
  claimed: ClaimedTarget,
  trusted: TrustedRunSignal,
  lookupPullsForCommit: LookupPullsForCommit
): Promise<VerifiedTarget | null> {
  if (claimed.headSha !== trusted.headSha) {
    throw new TrustViolation(
      `Artifact head SHA (${claimed.headSha}) does not match the workflow_run head SHA (${trusted.headSha}). Refusing to post.`
    );
  }
  if (claimed.repo !== trusted.baseRepo) {
    throw new TrustViolation(
      `Artifact repo "${claimed.repo}" does not match the trusted base repo "${trusted.baseRepo}". Refusing to post.`
    );
  }

  const pulls = await lookupPullsForCommit(trusted.baseRepo, trusted.headSha);
  if (pulls.length === 0) {
    // Benign: no open PR for this commit — merged/closed before the review ran. Not a violation; nothing to post.
    return null;
  }
  if (pulls.length > 1) {
    throw new TrustViolation(
      `Expected at most one open PR for ${trusted.baseRepo}@${trusted.headSha}, found ${pulls.length}. Refusing to post.`
    );
  }

  const [pr] = pulls;
  if (!pr) {
    // Defensive: length === 1 guarantees a member, but narrow it explicitly rather than assert.
    return null;
  }
  if (pr.number !== claimed.prNumber) {
    throw new TrustViolation(
      `Derived PR #${pr.number} for ${trusted.baseRepo}@${trusted.headSha} disagrees with the artifact's claimed PR #${claimed.prNumber}. Refusing to post.`
    );
  }

  return {
    commitSha: trusted.headSha,
    prNumber: pr.number,
    repo: trusted.baseRepo,
  };
}

/**
 * Teach-by-reply (ADR-0005 §3) posts a standalone PR comment, so its target is lighter than a review's: no
 * `commitSha` (nothing is pinned to a line). Built directly from the `issue_comment`/`pull_request_review_comment`
 * event payload, which is SAFE without a cross-check — GitHub runs these events from the base repo's DEFAULT
 * branch (never a fork's copy) and computes `repository`/`issue.number`/`comment.*` server-side, so none of it is
 * attacker-settable (unlike the gather artifact above).
 */
export interface TeachTarget {
  issueNumber: number;
  repo: string;
}

/** Author-association values that MAY teach — a cheap pre-filter; the authoritative gate is the permission level. */
export const TEACH_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** Repo permission levels that grant write — the authoritative teach gate (association alone doesn't imply write). */
const TEACH_PERMISSIONS: ReadonlySet<string> = new Set([
  "admin",
  "write",
  "maintain",
]);

/**
 * May this actor teach a rule via reply? A WRITE+SPEND action, so it is gated harder than a read-only phase:
 * the actor's association must be in {@link TEACH_ASSOCIATIONS} (cheap pre-filter) AND their repo permission must
 * grant write (the authoritative check — a COLLABORATOR can be read-only) AND they must not be the PR author (a
 * PR author teaching rules on their own PR is excluded per ADR-0005 §3). Pure; the workflow supplies the values.
 *
 * FAILS CLOSED: a missing actor OR a missing PR-author login (e.g. the workflow's author lookup failed) returns
 * false — an unknown PR author must not silently disable the author-exclusion rule. The author-exclusion compares
 * logins CASE-INSENSITIVELY: GitHub logins are case-insensitive ("Octocat" and "octocat" are one account), so a
 * case-only difference between the two payloads must never let a PR author teach on their own PR. Case-folding can
 * only ever exclude MORE, never grant more, so it strictly hardens the gate (fail-safe direction).
 */
export function isAuthorizedTeachActor(input: {
  association: string;
  actorLogin: string;
  permission: string;
  prAuthorLogin: string;
}): boolean {
  return (
    TEACH_ASSOCIATIONS.has(input.association) &&
    TEACH_PERMISSIONS.has(input.permission) &&
    input.actorLogin.length > 0 &&
    input.prAuthorLogin.length > 0 &&
    input.actorLogin.toLowerCase() !== input.prAuthorLogin.toLowerCase()
  );
}
