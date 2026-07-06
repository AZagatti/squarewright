# Design — Feedback & Data Signals

How Squarewright learns whether its reviews are good, and improves them. Direction: **local self-tuning
first, opt-in aggregate later.** 👍/👎 is only the most obvious signal — this maps the full space so the
design isn't cornered into one weak signal.

Principle: **code and diffs never leave the repo.** Anything that leaves (opt-in only) is numbers + enum
labels, k-anonymized, with an auditable schema published in this repo.

## Signal taxonomy

| Signal | Type | How captured | Improves | Privacy / gaming | Difficulty |
|---|---|---|---|---|---|
| 👍/👎 on a finding's inline comment | explicit | Reactions API on the review comment | per-rule/persona accept-rate | gameable by self-react → weight by collaborator permission, exclude PR author | easy |
| Reply verdicts ("false positive"/"good catch") | explicit | reply comments (`in_reply_to_id`), classified | persona/prompt tuning | text is fakeable, low incentive; classification ambiguity | medium |
| Thread resolve/unresolve | explicit | GraphQL `isResolved` | rule precision (with diff-check) | write-access gated; exclude bot's own resolves | medium |
| Dedicated react-to-tune command (`/squarewright not-relevant`) | explicit | comment-command parser on webhook | structured local auto-tune input | gate on live permission at webhook time | medium |
| Dismiss label (`squarewright:wontfix`) | explicit | `labeled` webhook | coarse per-PR reporting | label-add is permission-gated → high trust | easy |
| Flagged line changed in a later commit | implicit | diff flagged hunk across head SHAs, track by content-hash | per-rule precision (free, high-volume proxy) | correlation ≠ causation → weight low | medium |
| Suggestion block accepted/committed | implicit | diff a later commit against the emitted suggestion | strongest accept signal | hard to fake; exclude bot's own apply-commits | easy–medium |
| PR merged without addressing finding | implicit | join finding location vs final merge diff | precision denominator / noise baseline | event itself not gameable | easy |
| Independent human flags same spot | implicit | overlap human review comments vs finding, text-similarity | precision; grows the eval corpus (free ground truth) | ~ungameable | hard |
| Bot comment minimized/edited/deleted | implicit | GraphQL `minimizedReason` | structured negative signal | triage-gated → high trust | easy |
| Finding re-fires (or not) after a push | implicit | re-run review on new diff, compare | reviewer self-check | deterministic, ungameable | easy |
| Per-persona accept-rate | derived | aggregate accepts/total per persona | persona tuning / which to enable | pure aggregation | easy |
| Per-rule precision | derived | from accepts + eval corpus | default curation / per-repo suggestions | — | medium |
| Per-model quality | derived | accept-rate bucketed by model+persona | model-routing policy | needs model provenance on findings | medium |
| Cost & latency per review | derived | wall-clock + tokens around each Pi call | budget/tool-cap defaults, cost docs | internal telemetry only | easy |
| Noise / duplication rate | derived | near-duplicate findings (rule+file within N lines) | dedup logic, persona scoping | — | medium |
| Repeated dismissals → propose suppression | self-improve | cluster dismissed by rule+glob → propose `.squarewright.yml` diff | local self-tuning (the core ask) | never auto-commit — always a proposed diff | medium |
| Recurring accepted findings → strengthen persona | self-improve | cluster accepted by shape → propose prompt addition | local persona quality → candidate default | human-approved prompt-diff | medium–hard |
| `rule_suggestions` from the model | self-improve | structured field alongside findings | starts the "AI proposes a deterministic grounder" loop | slop risk → human curation gate | hard |

## Local vs. opt-in aggregate

**Strictly local (never leaves the repo):** anything with diff/code content or identity — raw
reactions/replies with usernames, comment text, resolve state, `rule_suggestion` raw text (quotes code), the
repo's own eval corpus, and every per-finding `{file, line, message}`. This is where local self-tuning lives:
`.squarewright.yml` suppression proposals, persona-prompt edits, per-rule accept-rates for *this* repo.

**Opt-in aggregate candidates (numbers + enum labels only):** per-rule accept-rate/precision by
`{rule_id, persona_id, language, repo_size_bucket}`; cost/latency per persona+model-tier; noise/duplication
rate; config-diff counts; `rule_suggestion` **category labels** (human-summarized, never raw text).

**Anonymization:** strip repo/owner (salted non-reversible install id, used only for dedup), strip
usernames/reactors, strip paths/lines/messages, **strip all code and diff hunks — full stop**, apply a
k-anonymity floor (suppress per-rule stats below N repos in a bucket → fall back to local-only), publish the
exact outgoing schema in this repo. Biggest leak risks to guard: `rule_suggestions` text, reply/comment text
(reviewers paste code), commit messages — dropped or enum-ized before anything leaves.

## Gaming / integrity

- **Self-👍/brigading:** count only reactions/replies from `write`/`maintain`/`admin` users; exclude the PR
  author from the trusted-tuning pool (still shown socially, not counted).
- **Sock-puppet replies:** live collaborator-permission check at webhook time, one vote per user per finding,
  provenance logged before any auto-tune lands.
- **Command/marker forgery:** server-authoritative permission check, strict grammar, and config-changing
  commands always land as a proposed diff/PR — never silently applied.
- **History erasure (force-push/close-reopen):** key findings by content-hash of the flagged hunk, not
  PR-number/line; treat lost tracking as "unknown," never silently count as accept.
- **Bot-on-bot contamination:** exclude the service account's own apply-commits from accept-detection.

## Recommended tiers

**v0.1 (local-only):**
1. 👍/👎 on inline comments, collaborator-weighted — GitHub-native, near-zero build/gaming cost.
2. Flagged-line-changed-in-a-later-commit — free, high-volume, zero user action.
3. Suggestion-block accepted/committed — strongest unambiguous accept signal.
4. Per-rule/persona accept-rate rollup of 1–3 — the one number a maintainer needs to tune `.squarewright.yml`.

**v0.x (local):** react-to-tune command; resolve/unresolve + minimized reason; repeated-dismissal →
proposed suppression diff; cost/latency + noise rate; model `rule_suggestions` (human-triaged).

**Later (opt-in aggregate):** per-rule precision by language+size bucket (k-anonymized numbers); fleet-wide
config-diff telemetry; human-overlap-derived corpus growth (labeled hit/miss pairs, never raw text).
