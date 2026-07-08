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

/** The artifact's self-reported identity — untrusted; used only to cross-check, never as a source of truth. */
export interface ClaimedTarget {
  headSha: string;
  prNumber: number;
  repo: string;
}

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
 * on any mismatch between the untrusted artifact and the trusted run, or when the commit does not resolve to
 * exactly one open PR. The returned target is composed entirely from trusted inputs.
 */
export async function verifyPostingTarget(
  claimed: ClaimedTarget,
  trusted: TrustedRunSignal,
  lookupPullsForCommit: LookupPullsForCommit
): Promise<VerifiedTarget> {
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
  if (pulls.length !== 1) {
    throw new TrustViolation(
      `Expected exactly one open PR for ${trusted.baseRepo}@${trusted.headSha}, found ${pulls.length}. Refusing to post.`
    );
  }

  const [pr] = pulls;
  if (!pr) {
    throw new TrustViolation(
      `No open PR resolved for ${trusted.baseRepo}@${trusted.headSha}. Refusing to post.`
    );
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
