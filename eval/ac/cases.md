# AC-conformance eval corpus — seed (2026-07-13)

Measurement substrate for the question: **does a checklist-AC-conformance reviewer add value beyond what
defect-persona reviewers (correctness/security/etc.) already catch?** Mirrors the verification rigor of
`eval/divergence-cases.md` — real links, hand-verified against the actual merged diff, no fabrication. Per the
task brief, **no product feature is built here** — this is corpus + findings only.

## Corpus-shape caveat (read first)

The task asked for issues with a **checkbox-style** AC block (`- [ ]` / `- [x]`). Checked: **zero** of
squarewright's own closed issues use literal GFM checkboxes. `.github/ISSUE_TEMPLATE/ready-task.yml`'s
"Acceptance criteria" field is a free-text `textarea`, and every issue in this repo instead ships an itemized
bullet/numbered list under an "### Acceptance criteria" (often "(ATDD)") heading — same *checkable-item* shape a
conformance checker would need, just not the `- [ ]` markdown syntax. I treated each such bullet as one AC item;
see "Harness observations" below for what a real implementation would need to match on instead.

## Methodology

1. `gh api graphql` `closedByPullRequestsReferences` on all closed issues in `AZagatti/squarewright` → issue→PR
   candidate pairs.
2. **Verified each pairing is real**, not a GraphQL false-positive (see harness note #1 — one candidate,
   issue #64, was discarded because the linkage was spurious).
3. For each surviving pair: read the issue's verbatim AC list, `gh pr diff <n>` the merged diff, and judged each
   AC item met / partial / unmet with a citation into the diff or PR body.

## Summary table

| id | issue | PR | +/- | AC items | met | partial/transparent-gap | unmet | verdict |
|---|---|---|---|---|---|---|---|---|
| ac-sw-37 | [#37](https://github.com/AZagatti/squarewright/issues/37) | [#41](https://github.com/AZagatti/squarewright/pull/41) | +208/-24 | 6 | 6 | 0 | 0 | clean full match |
| ac-sw-26 | [#26](https://github.com/AZagatti/squarewright/issues/26) | [#27](https://github.com/AZagatti/squarewright/pull/27) | +262/-9 | 4 | 4 | 0 | 0 | clean full match |
| ac-sw-52 | [#52](https://github.com/AZagatti/squarewright/issues/52) | [#58](https://github.com/AZagatti/squarewright/pull/58) | +40/-15 | 3 | 3 | 0 | 0 | clean full match |
| ac-sw-61 | [#61](https://github.com/AZagatti/squarewright/issues/61) | [#62](https://github.com/AZagatti/squarewright/pull/62) | +46/-0 | 3 | 3 | 0 | 0 | clean full match (docs-only) |
| ac-sw-40 | [#40](https://github.com/AZagatti/squarewright/issues/40) | [#43](https://github.com/AZagatti/squarewright/pull/43) | +42/-1 | 3 | 3 (1 via its own documented fallback clause) | 0 | 0 | met, nuanced |
| ac-sw-39 | [#39](https://github.com/AZagatti/squarewright/issues/39) | [#44](https://github.com/AZagatti/squarewright/pull/44) | +749/-27 | 5 | 4 | 1 (transparent, documented reversal) | 0 | met + one disclosed deviation |
| ac-sw-71 | [#71](https://github.com/AZagatti/squarewright/issues/71) | [#84](https://github.com/AZagatti/squarewright/pull/84) | +535/-0 | (prose, no numbered ACs) | — | 1 (transparent, PR body flags it) | 0 | met + one disclosed gap |
| **ac-sw-70** | **[#70](https://github.com/AZagatti/squarewright/issues/70)** | **[#80](https://github.com/AZagatti/squarewright/pull/80)** | +392/-58 | 1 headline "ship gate" | 0 | 0 | **1 (silent)** | **GOLD — silently unmet ship-gate on a bug-free, adversarially-reviewed PR** |

8 cases, all self-repo (sufficient volume + a confirmed gold case — external mining skipped per the task's
priority order, "only if self-repo yields too few").

---

## ac-sw-70 — GOLD CASE: silently unmet ship-gate on a bug-free PR

**Issue [#70](https://github.com/AZagatti/squarewright/issues/70) — "M6 §2: rule-drift finding (propose a
paste-ready rule)"**

Verbatim AC (the issue is short; its one substantive gate is the operative AC):

> **Ship gate (council, measurement-first):** a **paired fixture** (mirror `scripts/measure-rules.ts`) with
> trigger cases (should propose) AND non-trigger/already-covered cases (should stay silent). Metric = **proposal
> precision** at ≥3 runs, reported as a range: proposes on triggers most runs, ~zero false proposals on
> clean/covered. Not "proposed something plausible once."

**PR [#80](https://github.com/AZagatti/squarewright/pull/80) — merged 2026-07-10, `+392/-58`.**

What the PR actually delivers, verified against the diff:
- `src/pi/worker.ts`: `capRuleDrift` (deterministic ≤1-proposal-per-pass cap), `submittedToFinding` carries
  `proposedRule` through, pass-2 (structurer) gating symmetric with pass-1 — all real, all unit-tested
  (`src/pi/worker-ruledrift.test.ts`, 91 lines, 7 tests, all pure/mocked, no LLM calls).
- `src/output/aggregate.ts`: fixed a real bug the reviewer's own adversarial pass (`sqw-reviewer`) caught —
  `aggregateFindings` was dropping `proposedRule` on merge (`src/output/aggregate.test.ts`, new file, was zero
  coverage before this PR).
- `src/assembly/review.ts`: `proposeRuleDrift` gated on `preamble.length > 0` (repo opted into rules), tested.
- PR body: "`sqw-reviewer` … returned REQUEST-CHANGES with 3 legit must-fixes, all addressed" — this is a
  genuinely well-reviewed, low-defect-risk PR. `verify:pr` green, 156 tests.

What the ship gate actually asked for vs. what shipped, cited directly against the PR's own "Verification"
section:

> **Real end-to-end smoke on the shipped free default** … synthetic PR with a recurring `console.log(req.body)`
> pattern across two files + one loaded rule that does *not* cover it:
> - `proposeRuleDrift: true` → **1** well-scoped proposal … cap held.
> - `proposeRuleDrift: false` (control) → **0**.
> - Whether the model proposes on a given run varies — by design (at-most-one, only-when-it-clearly-qualifies).

This is **one manual run each way**, not the "paired fixture … ≥3 runs … reported as a range" the issue's ship
gate demanded. There is no new fixture file mirroring `scripts/measure-rules.ts` anywhere in the diff (checked:
`git diff --stat` for #80 touches `eval/RESULTS.md`, `eval/runs.jsonl`, `src/assembly/review.ts(.test.ts)`,
`src/output/aggregate.ts(.test.ts)`, `src/pi/session.ts`, `src/pi/worker-ruledrift.test.ts`,
`src/pi/worker.ts` — no `eval/rules-precision-fixture`-style trigger/non-trigger case set, no `--repeat 3` run,
no precision-range number anywhere). The `eval/RESULTS.md` section this PR *does* add is a real, rigorous ≥3-run
measurement — but of a **different, unrelated question** (matched-structurer cross-family model rank, sonnet-5
vs glm-5.2 recall), not rule-drift proposal precision. It reads, at a skim, like the ship-gate box got checked;
it did not.

**Why this is silent, not disclosed:** the PR body's own framing ("✅ Verification … 156 tests … Real
end-to-end smoke") presents the work as complete and verified. Nothing in the PR body, the `sqw-reviewer` verdict
("No issues found … acknowledged as intentional choices"), or the squarewright self-review sticky
(`No issues flagged by Correctness, Security`) flags the ship-gate's specific ≥3-run/paired-fixture/precision-range
requirement as unmet. A human skimming "182 tests… verification section… closes #70" would reasonably believe the
gate was cleared. `#73` ("Measure the PRECISION cost of loading rules") is later opened as a still-open follow-up,
which is indirect evidence the precision question genuinely was never closed out here — but #73 doesn't reference
#70's specific ship gate either.

**Why a defect-persona reviewer would never catch this:** every defect lens (Correctness, Security, …) reviews
*code quality of what's there*. The gap here is not a bug in `capRuleDrift` or `aggregateFindings` — those are
correct and well-tested. The gap is a **claim vs. deliverable mismatch**: the issue demanded a specific, falsifiable
measurement artifact as the literal condition for shipping, and the PR substituted a qualitatively different
(single-run, not-a-fixture) demonstration while narrating it as verification. Only an AC-conformance check that
reads the issue's checklist *and* cross-checks each item against the diff (not just "does this code have bugs")
would catch it.

---

## ac-sw-39 — met + one transparently reversed AC

**Issue [#39](https://github.com/AZagatti/squarewright/issues/39) — "M5: correlated-pair batching via a persona
'pass' group key"**

Verbatim ACs:
1. `Persona` gains optional `pass?: string`; `solo:true` normalizes to `pass:id` in the schema. Test: solo
   round-trips to a singleton group.
2. `buildPasses`: personas sharing a `pass` key collapse into ONE `ReviewPass`… no-key personas fall into
   `baseline`… solo still gets its own pass.
3. `selectPersonas`'s `MAX_PERSONAS` cap is **group-aware** — never keeps one member of a declared group while
   dropping its partner.
4. **`DEFAULT_PERSONAS` declares ≥1 real correlated pair with a rationale comment**; `renderDefaultConfig` still
   round-trips.
5. **Eval validation**: `--repeat 3` free-z.ai on a golden case tripping the paired globs — pass/Worker-call
   count drops as expected; recall/FP rates hold within noise; recorded as a dated `eval/RESULTS.md` section.

**PR [#44](https://github.com/AZagatti/squarewright/pull/44) — merged 2026-07-08, `+749/-27`.**

- AC1 — **met**: `src/core/types.ts` adds `pass?: string`; `passGroup()` in `src/personas/defaults.ts`
  (`p.pass ?? (p.solo ? p.id : "baseline")`); `src/personas/defaults.test.ts` covers the solo→singleton
  round-trip.
- AC2 — **met**: `buildPasses` rewritten to `Map<string, Persona[]>` grouping by `passGroup`, one `ReviewPass`
  per group; multi-lens preamble only used when `members.length > 1`. `src/personas/defaults.test.ts` covers
  batching + solo-still-alone.
- AC3 — **met**: `src/personas/routing.ts` cap logic + `src/personas/routing.test.ts` (5 new tests) explicitly
  test the exact "mid-group truncation drops the WHOLE group rather than splitting it" scenario named in the AC.
- AC4 — **unmet, but transparently reversed, not silent**: `git diff` on `src/personas/defaults.ts` shows the
  `pass` field is never added to any of the 6 real `DEFAULT_PERSONAS` entries (stevedore/marshal, the Docker+CI
  pair the AC's own rationale example names, stay unpaired). Instead `src/personas/defaults.test.ts` adds a new
  test asserting the opposite: `"a PR touching BOTH a Dockerfile and a CI workflow runs stevedore and marshal as
  SEPARATE passes"`, with the comment `// … So stevedore and marshal run SEPARATELY by default — the pairing
  stays opt-in via config.` `eval/RESULTS.md`'s new "M5 batching intensity" section explains why: measurement
  showed the corpus can't validate any specific pairing (no case co-touches Docker+CI) and a hand-built probe
  showed pairing gave **no** recall advantage (every persona already sees the full multi-file diff regardless of
  batching). The PR explicitly documents this as a **decision to ship the primitive, not the default pairing** —
  a disclosed, reasoned deviation from the literal AC text, and a legitimate one (the AC's own instinct was
  wrong, and the PR shows its work).
- AC5 — **met**: `eval/runs.jsonl` gets 9 new dated rows (`batching: split|current|batched`, 3 repeats each);
  `eval/RESULTS.md` "M5 batching intensity" section reports ranges + medians per mode, exactly the ≥3-run/range
  shape the AC asked for.

**Note:** this is the useful contrast case to ac-sw-70. Same shape (an AC literally unmet) but the opposite
posture: the gap is loud, reasoned, and cited in the PR's own eval section. A conformance checker reading only
the issue+diff (no eval/RESULTS.md context) could still misflag this as "AC4 unmet" — a real implementation
would need some way to recognize an in-PR justification as a legitimate resolution, not just literal string
matching against the AC text. That's a design risk worth flagging for any future conformance-check feature.

---

## ac-sw-71 — met + one disclosed live-validation gap

**Issue [#71](https://github.com/AZagatti/squarewright/issues/71) — "M6 §3: teach-by-reply → inline rule
suggestion"** (prose issue body, no numbered checklist — ADR-0005 §3 is the spec).

**PR [#84](https://github.com/AZagatti/squarewright/pull/84) — merged 2026-07-10, `+535/-0`.**

- `src/safety/trust.ts` `isAuthorizedTeachActor` — permission-gated (write/maintain/admin) + actor≠author,
  4 new tests. Matches the issue's "permission-gated … PR-author excluded" requirement.
- `src/assembly/teach-post.ts` `runTeachCommand` — reads trusted env, authorizes before the model runs, fail-
  closed on missing signals, 6 tests.
- Trigger choice: issue's "Open confirm" asked `@squarewright` mention vs `/squarewright remember` vs both,
  "recommended `@squarewright`" — PR ships `@squarewright` only, matching the recommendation (a real, resolved
  stop-condition fork).
- **Disclosed gap**: PR body's own "Needs live validation" section: *"The workflow event/permission plumbing
  isn't locally mockable — before relying on it, test with a real `@squarewright remember: …` reply on a PR."*
  182 unit tests are green, but the live GitHub round-trip (does the workflow actually trigger, does the
  permission check correctly resolve real GitHub API `author_association`/permission fields) is explicitly
  **not yet verified** at merge time. This is transparent — the PR says so — but it is a genuine "verified only
  by construction, not by observation" gap that a literal reading of ADR-0005 §3 ("renders as an inline
  suggestion") would not catch from the diff alone; you'd need to know live validation hadn't happened yet.

---

## ac-sw-40 — met via its own documented fallback clause

**Issue [#40](https://github.com/AZagatti/squarewright/issues/40) — "Enforce config.budget (parsed but silently
ignored)"**

Verbatim ACs:
1. `runReview` threads `config.budget` into each `worker.run(...)` call. Test asserts the worker receives it.
2. Absent `budget` → `worker.run` gets no budget (unchanged). Test.
3. *(If cheap)* the worker actually honors `maxToolCalls` as a stop — **else document that enforcement is the
   worker's responsibility and this only wires it through.**

**PR [#43](https://github.com/AZagatti/squarewright/pull/43) — merged 2026-07-08, `+42/-1`.**

- AC1 — met: `src/assembly/review.ts` `worker.run({ budget: config.budget, … })`;
  `src/assembly/review.test.ts` new test `"forwards config.budget to the worker"` asserts
  `received?.budget` equals the config's budget.
- AC2 — met: new test `"forwards no budget when the config has none"` asserts `received?.budget` is
  `undefined`.
- AC3 — met via its own stated fallback: the PR does **not** make the worker enforce `maxToolCalls`; instead it
  adds the code comment `// budget flows to the worker so a future enforcer can honor it; today it's
  ADVISORY — the worker doesn't read it, because a hard mid-run tool-call/token cap needs an abort primitive Pi
  doesn't expose.` — which is exactly the AC's own documented-fallback branch, satisfied as written rather than
  silently skipped.

A clean, unremarkable "met" case included as a control: shows a conditional AC can be legitimately satisfied by
its own escape clause, and that a naive conformance checker (looking only for "is `maxToolCalls` enforced?")
would need to parse the AC's own conditional logic correctly or it would false-flag this as unmet.

---

## ac-sw-37 — clean full match (control)

**Issue [#37](https://github.com/AZagatti/squarewright/issues/37) — "Honesty in the review output: persona
attribution + no-overclaim on clean"**, 6 ATDD-numbered ACs (lens labels on findings, consensus names agreeing
lenses, no bare "No blocking issues found ✅", honesty footer, inline comments carry lens label, optional persona
`label` field). **PR [#41](https://github.com/AZagatti/squarewright/pull/41)**, merged 2026-07-08, `+208/-24`.

All 6 verified directly against the diff: `src/output/render.ts` adds `Lens`, `labelResolver`, `provenance`,
`honestyFooter`; `renderSticky`'s clean-message changes from `"No blocking issues found. ✅"` to
`"No issues flagged by {roster}{model} — it means nothing obvious was found, not that the change is verified
correct."`; `src/github/inline.ts` `mapToInlineComments` gains `labelFor`; `src/core/types.ts` `Persona.label?`;
`src/personas/defaults.ts` + `.squarewright.yml` both get `label:` on all 6 default personas. Each AC has a
dedicated new/updated test in `render.test.ts`, `inline.test.ts`, `review.test.ts`, `config.test.ts`. No gaps
found. Included as a "what a fully-matched PR looks like" baseline for calibrating the other cases.

---

## ac-sw-26 — clean full match (control)

**Issue [#26](https://github.com/AZagatti/squarewright/issues/26) — "M4.1 — squarewright doctor"**, 4 ACs
(`runDoctor(cwd, deps)` structured report; injected effects; `renderDoctor` human output + correct exit code;
`requiredProviders` exported + reused). **PR [#27](https://github.com/AZagatti/squarewright/pull/27)**, merged
2026-07-08, `+262/-9`.

All 4 verified: `src/assembly/doctor.ts` (new, 118 lines) matches the signature and behavior exactly, including
the AC's specific nuance "gh-missing is a warning, not a hard failure" (`renderDoctor` emits `⚠` not `✗` for
missing `gh`, `doctorProblems` doesn't count it); `src/assembly/review-post.ts`'s `requiredProviders` changed
from private to `export function` and reused by `doctor.ts` (no duplicated provider logic, as required);
`src/cli.ts` wires it with the correct exit-code behavior. 6 new tests in `doctor.test.ts` cover exactly the 4
report/render permutations the AC implies (all-green, missing key, invalid config, missing gh). No gaps.

---

## ac-sw-52 — clean full match (control)

**Issue [#52](https://github.com/AZagatti/squarewright/issues/52) — "Harden --max-spend parsing in eval.ts +
spike.ts"**, 3 ACs (reject non-finite/negative `--max-spend` in both scripts; consider extracting a shared
validator; default behavior unchanged). **PR [#58](https://github.com/AZagatti/squarewright/pull/58)**, merged
2026-07-09, `+40/-15`.

All 3 verified: `scripts/lib/spend-guard.ts` gains exported `parseMaxSpend(raw, fallback)`; `scripts/eval.ts` and
`scripts/spike.ts` both switch from `Number(arg("max-spend") ?? 0.5)` to `parseMaxSpend(arg("max-spend"), 0.5)`;
`scripts/judge.ts`'s pre-existing local `parseMaxSpend()` (from PR #51, cited in the issue) is deleted and
replaced with a call to the same shared function — genuinely satisfies the "consider extracting" AC rather than
leaving 3 copies. 3 new tests in `spend-guard.test.ts` cover fallback/valid/reject. No gaps.

---

## ac-sw-61 — clean full match, docs-only (control)

**Issue [#61](https://github.com/AZagatti/squarewright/issues/61) — "Fast cross-family judge via a Claude
subagent"**, 3 ACs (AC1: documented judge-subagent protocol; AC2: agreement check on ≥2 saved reports; AC3: a
short doc on when to use which judge). **PR [#62](https://github.com/AZagatti/squarewright/pull/62)**, merged
2026-07-09, `+46/-0`, **one new file**: `docs/reference/subagent-judge.md`.

Notable because the issue's own "Evidence/checks" said "No code required to pass AC1/AC2 … mostly docs" — and
the PR delivers exactly that. AC2 verified directly: the PR body's table shows 2 reports, subagent score vs
`scripts/judge.ts` score, both agreeing (`4/11` vs `4–5 median 4`; `6/11` vs `6` from two judges) — a real
side-by-side comparison, not a claim. AC3 verified: the PR body states the doc is explicit that
`scripts/judge.ts` stays CI/programmatic, subagent stays interactive. Included to show the corpus isn't only
`src/` diffs — a docs-only PR can be AC-conformance-checked exactly the same way, and this one is honest and
complete.

---

## Harness observations (not fixed here — flagging for whoever builds this)

1. **`gh api graphql` `closedByPullRequestsReferences` produces at least one false positive.** Issue #64 ("M6
   slice 1: feedback ledger…", 6 heavy ACs) showed PR #74 as its closing PR. Checked the issue's timeline
   directly (`gh api repos/.../issues/64/timeline`): the `closed` event fired at `05:08:31Z`, **3 minutes before**
   PR #74 was even cross-referenced (`05:11:16Z`) or merged (`05:11:42Z`). PR #74 turned out to be a pure
   docs/roadmap-hygiene PR ("Council-directed tracker + doc hygiene… closed #64… done via gh") — issue #64 was
   manually closed via `gh issue close` as part of a re-scope (its ACs were split into #70/#71/#72), and #74
   merely referenced the now-closed number in prose. **A conformance-check feature must not trust
   `closedByPullRequestsReferences` (or any single-signal "closes #N" heuristic) without cross-checking that the
   close event and the PR merge are actually the same act** — this repo's own automation makes that mostly true
   (see #2) but not always.
2. **This repo never uses GitHub's native "Closes #N" commit-message auto-close.** Across all 21 verified pairs,
   `timeline`'s `closed` event always has `commit_id: null`, and the close timestamp is within 1–2 seconds of the
   PR's `mergedAt` — meaning the repo's own merge script explicitly runs `gh pr merge` then `gh issue close` (or
   equivalent) rather than relying on merge-commit keyword linking. **A robust implementation should key off
   close-timestamp-adjacent-to-merge-timestamp, not `commit_id` presence or PR-body keyword parsing alone** —
   the keyword parsing would find nothing (see caveat above) or the wrong thing (#64) in this repo.
3. **No issue in this repo uses literal `- [ ]` GFM checkboxes.** Every AC list is `### Acceptance criteria` (or
   "(ATDD)") followed by a bullet or numbered list, per `.github/ISSUE_TEMPLATE/ready-task.yml`'s free-text
   `textarea`. A pattern-match for GFM checkbox syntax would find **zero** cases in squarewright's own history;
   detection needs to key off the section heading + list-item structure, not checkbox markup specifically. (This
   corpus does that — see the caveat at the top.)
4. **PR body prose is not a reliable substitute for AC verification** — ac-sw-70 is the sharpest illustration:
   its "Verification" section reads as confident and complete ("✅ … 156 tests … Real end-to-end smoke") while
   silently failing to deliver the ship gate's actual falsifiable metric. Any conformance check that just asks an
   LLM "does the PR description say the ACs are done?" would be fooled the same way a human skim was.

---

## Honest read: does a checklist-AC-conformance check look like it has real value?

**Yes, directionally — but on a thin, single-mechanism sample.** Out of 8 solid cases:

- **5 are clean matches** an AC-conformance check would correctly report as "all met" — no signal there, but
  also no false alarm, which matters (a checker that cries wolf on clean PRs is worse than useless).
- **2 are transparently-disclosed gaps** (ac-sw-39, ac-sw-71) where a conformance check would need to be
  careful not to blindly literal-match the AC text against the diff and flag a false unmet — it would need to
  weigh in-PR/in-repo justification (eval/RESULTS.md reasoning, an explicit "needs live validation" caveat) as a
  legitimate resolution. Built naively, a conformance checker is as likely to generate **noisy false "unmet"
  flags on good, disclosed engineering judgment** as it is to catch a real gap — this is the main precision risk
  and mirrors the "reasoning ≠ better review" and "prompted-CoT cuts false positives" lessons already banked in
  project memory for defect personas; the same craft would be needed here.
- **1 is a genuine gold case** (ac-sw-70): a bug-free, unit-tested, adversarially-reviewed PR that silently
  substitutes a weaker deliverable (one manual smoke test) for an explicit, falsifiable ship gate (paired
  fixture, ≥3 runs, precision as a range) — and narrates it as done. This is exactly the class of miss the task
  brief predicted defect personas can't catch, because nothing here is a code defect.

**The honest caveat: N=1 gold case out of 8 is a lead, not a rate.** It shows the failure mode is *real* (it
happened, in this repo, unprompted, from a capable agent under real review pressure) but says nothing about how
*often* it happens. Before treating this as justification to build the feature, the same measurement discipline
already established for the review-quality lenses should apply: multiple repos/PR-authors (this whole corpus is
one agent's PRs in one repo — a strong prior toward self-consistent claims, not adversarial ones), and ideally a
few more gold-shaped candidates before committing engineering time. What this corpus *does* support is a
narrower claim: **it is plausible enough to be worth a small, cheap follow-on measurement round** (e.g. mining
2–3 more agent-authored repos' issue/PR pairs the same way, or running an eval-style pass where a model is asked
"does this diff satisfy every AC in this issue" against these 8 labeled cases to see if it reproduces the ac-sw-70
miss) before deciding to build a checklist-AC-conformance persona/pass for real.
