# ADR 0005 — Feedback signal storage & the learning mechanism (M6)

Status: Proposed · 2026-07-09

## Context

M6 — the "local feedback loop" — is the North-Star differentiator: *"gets better from your feedback without
ever changing itself behind your back… any change to its own rules is proposed to you, never auto-applied"*
([`NORTH_STAR.md`](../../NORTH_STAR.md)). It has sat blocked on one question — **where do feedback signals live,
and how do they actually improve reviews?** ([`ROADMAP.md`](../ROADMAP.md) M6; issue #50).

Two hard constraints shape everything:

1. **We do not own or train the model** (Pi drives a swappable third-party LLM). "Improve" can **never** mean
   fine-tuning — only **assembly tuning** (`.squarewright.yml`, persona prompts, rules, curated exemplars).
2. **Human-gated.** A change is **proposed** as a PR the maintainer merges, never silently applied.

**Scope (maintainer-decided):** M6 is **per-repo local self-tuning** — each user's repo learns from *its own*
feedback and tunes *its own* assembly. Improving Squarewright's *shipped defaults* from cross-user aggregate is
a **separate, later, opt-in "tool-level" tier** — out of scope here.

Grounding: a 3-member design council, a **sourced web survey** (CodeRabbit, Qodo/PR-Agent, Greptile, Sourcery,
Bito, Graphite) + academic prior art (DeepCRCEval; the many-shot-paradox; RLHF-sycophancy; APO/GEPA
train-val-test), the trimwire reference, and this repo's own M5/M7 measurement lessons. **Key external facts:**
nobody fine-tunes (every shipped "learning" is prompt-injected rules or a retrieval filter); **CodeRabbit
explicitly abandoned 👍/👎 as the learning signal because thumbs get sycophancy-hacked**; and **every comparable
tool auto-applies** its learned change — only CodeRabbit even delays. Our mandatory human gate is therefore an
*above-industry-norm* safety stance, deliberately kept — but delivered as an **auto-opened PR with a
plain-English body** so a user actually understands it (the earlier "bare config diff" was bad UX).

## Decision

### 1. Storage — an anonymized signal ledger on a dedicated git branch
Persist derived signals to a dedicated orphan branch (`squarewright-signals`), **never merged to `main`** — a
per-event, PII-stripped *ledger* (aggregation happens downstream in Rollup). Established CI pattern
(`benchmark-action/github-action-benchmark`), the improved shape of trimwire's approach.
- **Split raw vs. derived.** GitHub durably stores raw explicit signals (👍/👎, resolved-state) — read live via
  the API, don't duplicate. Only **derived** data lives on the branch.
- **Anonymized, never PII:** `{rule_id, persona_id, glob/lang bucket, content_hash, outcome, observed_at}` — no
  usernames, paths, line numbers, message text, or code. (Public repo → the "strictly local" tier must meet its
  own *aggregate* privacy bar.)
- **Improve on trimwire** (recollected internals, not re-verified): content-hash key the flagged hunk (survives
  force-push); **permission-gate** (write/maintain/admin reactors only, exclude the PR author); route every
  write through **`Poster`** (never raw `gh`/`git`); publish a **versioned schema**; **compact** old detail.
- **Weight signals by trust, not affection.** 👍/👎 is weighted **below** the two *behavioral* signals
  (flagged-hunk-changed-later, suggestion-committed-verbatim) — behavioral signals are far harder to
  sycophancy-hack (CodeRabbit's exact lesson).

### 2. The learning mechanism — four stages (no LLM in the *deciding* path)
1. **Capture** (trusted `review` zone). Each posted comment carries a hidden marker (`rule`/`persona`/
   `content-hash`; `Finding.source` exists). A job mines reactions/resolved-state + the two implicit signals,
   permission-gated, appended to the ledger. Observation, **no gate**.
2. **Rollup** (deterministic — a Policy/Grounder, **never an LLM**, Hard Rule 2). Per `{rule_id, persona_id,
   glob}`: accept-rate + sample size → suppression / persona-strengthening **candidates** above the evidence
   floor. **The decision (which rule, suppress vs. strengthen) is always deterministic here** — AI-assist
   (below) never touches it.
3. **Draft** — turn one candidate into a diff + a **plain-English PR body**. Two interchangeable *methods*
   behind one interface: **`deterministic`** (template diff + numeric evidence + verbatim exemplars — ships
   slice 1) and **`ai-assist`** (an LLM drafts only the *connective prose/rationale* and *curates* which of the
   already-eligible exemplars to include — **never** the decision, **never** invents rule text, **never** sees
   raw untrusted PR text; ships slice 2, **off by default** until §6's comparison clears it).
4. **Gate-and-open** — every draft runs the regression gate (§6) before a PR opens. **PASS** → open the PR with
   the before/after numbers + generation method in the body. **FAIL** → don't open; log the rejected proposal
   to the ledger (so a re-run doesn't silently retry it) and surface a heads-up to the maintainer, not silence.

### 3. Curated few-shot exemplars (content of "strengthen persona" proposals)
Attach **2–5 curated accepted findings** as exemplars in the persona prompt (not an abstract instruction) —
matches the strongest evidence (DeepCRCEval; the many-shot-paradox: small curated sets beat both zero-shot and
"dump everything"). **Cumulative cap ~≤25 exemplars per persona** across supersessions, **enforced in code**.
Exemplar text is fetched **live from the bot's own prior comment by content-hash** at proposal time (the ledger
stores no text), and the PR body **flags its provenance** ("sourced from PR #N, in response to third-party diff
content") — see the injection risk below.

### 4. Supersession, not accumulation
A new proposal contradicting/duplicating an existing rule/exemplar **replaces** it; never stacks. Enforced in
code (unbounded natural-language "learnings" produce conflicting behavior — CodeRabbit's documented failure).

### 5. Deferred: retrieval/embeddings (v0.x)
Greptile/Sourcery's embedding-filter (best *evidenced* result — 19%→55% address-rate) needs vector infra;
stays deferred to the roadmap's "Later — opt-in aggregate" tier.

### 6. The 3-way comparison + the regression gate — two honest checks, never blended
A per-repo tuning change has **no reason to move recall/precision on our 18 unrelated golden PRs** — and our
corpus is already too noisy to detect even a *bigger* intervention (M5 batching was blocked at recall 1–2/12,
median 1). So a golden-corpus before/after is **not** proof a change *helps* a repo. Split it:

- **(a) Shared-corpus sanity floor** (cheap, every proposal, PASS/FAIL). A *structural* check: assembly still
  loads, personas still fire, exemplar cap respected, no false-positive spike / finding-count collapse. Catches
  a **broken** diff (which breaks everywhere), **not** a good one. Gate on **range non-overlap in the regressive
  direction** across ≥3 repeats — never a single-run point delta (judge stochasticity: the subagent judge
  re-scored an identical report 4 then 6; glm-5.2 spanned 2–8 in M7).
- **(b) Local accept-rate** (the *real* evidence, **reported not pre-gated**). The Rollup numbers from *this
  repo's own* feedback go in the PR body as primary justification, plus a **promised follow-up** delta after the
  change is live. It can't pre-gate (it's post-hoc) — the maintainer merges on the local numbers + the sanity
  floor.

**Deciding whether AI-assist (§2.3) ships** = the maintainer's baseline × deterministic × ai-assist comparison:
run all three arms **on identical evidence** (same signals in — only generation differs), ≥3 corpus repeats
each, defect-judged, reported as **ranges**. `ai-assist` becomes default only if its recall range is strictly
above deterministic's with no overlap **and** precision doesn't regress; else it stays experimental/off.
Qualitative gains (better PR prose) are tracked as a *separate, explicitly-qualitative* axis, never blended in.

**Goodhart guard (architectural, not policy):** the `src/feedback/` module **never imports from `src/eval/`**;
only a separate measurement script reads the corpus, once, after the diff is fixed — there is **no loop** that
regenerates a proposal "until the corpus passes." Per-repo held-out signal sets are **rejected for v0.1** (per-
repo volume is smaller than our already-underpowered corpus) — revisit as v0.x if a repo accumulates volume.

## Trust boundary
Signals are captured/persisted **only in the trusted `review` zone**; the signals branch is **never read by
`gather`**; raw public-PR signals are **permission-gated before** they influence tuning. **Sharpest edge —
second-order injection via exemplars:** exemplar text ultimately derives from a third-party PR diff (through the
bot's own finding), so a proposal could paste adversarial instructions into a trusted persona prompt. Reliable
sanitization of injection text is unsolved — the **defense is the human merge gate + explicit provenance-flagging
in the PR body**, and the ai-assist drafter never emitting free-text rule bodies (structured diffs only).

## Implementation sequencing (2 slices)
- **Slice 1** — Capture + ledger branch + **deterministic** Rollup + deterministic Draft + the regression gate;
  measure **baseline vs deterministic** and record the range in `eval/RESULTS.md`. No LLM anywhere. (Ready-task
  issue filed separately.)
- **Slice 2** — the **ai-assist** Draft method, shipped **off by default** until the 3-way comparison (§6)
  shows it beats deterministic without regression.

## Decisions the maintainer must confirm (before implementation)
1. **Trigger + threshold** — auto-drafted on a schedule vs. dispatch-only; and the evidence floor. *Council
   lean (tightened): **≥5 distinct-user signals AND a ≥14-day window** per bucket — a count-only floor is too
   cheap to hit even permission-gated.*
2. **Write scope** — *council lean (revised): do **not** widen the hot `squarewright-review.yml` token; use a
   **separate fine-grained token / App scoped only to the signals + proposal branches**, invoked by the new
   low-frequency job — smaller blast radius.*
3. **Poll model — now coupled to the judge (new).** The regression gate's preferred judge is the **Claude
   subagent** (fast, free, cross-family) which **cannot run headless**. So a **scheduled cron** trigger can only
   use `scripts/judge.ts` (and should then use the cross-family `deepseek-v3.2`, not same-family GLM), whereas a
   **dispatch-triggered** proposal step keeps the subagent judge available. *These two are no longer independent
   — pick: (cron + deepseek judge, fully autonomous) or (dispatch + subagent judge, interactive).*

## Risks (named, not buried)
- **Judge stochasticity vs. corpus size.** 11 loci with a ~2-loci repeat spread; a small diff plausibly moves
  recall 0–1 loci — inside the noise. The gate risks being too loose (misses regressions) or too paranoid
  (blocks safe changes). The range-non-overlap rule mitigates but does not eliminate this — the **local
  accept-rate is the real evidence**, the corpus is only the broken-diff floor.
- **Chicken-and-egg evidence.** No real per-repo signals exist yet (dogfood is new; trimwire hasn't migrated).
  Slice 1's comparison must use a clearly-labeled **synthetic** fixture and a **tracked follow-up** to re-run on
  real signals — never let synthetic quietly become the permanent "proof" (Hard Rule 5).
- **Second-order exemplar injection** (above) — the design's sharpest edge; human gate + provenance is the
  defense.
- **Content-hash fingerprinting** on a low-traffic public repo: a public content-hash can be traceable to a
  specific PR/commit even with no PII stored. A caveat, not a blocker.

## Non-goals
No fine-tuning. No silent auto-apply (always a PR you merge). No LLM in the *deciding* path. No vector store/RAG
in v0.1. No free-text "learnings" accumulation (structured + superseding). No cross-repo aggregate telemetry
(separate opt-in tier). No v0.x signals (react-to-tune, resolve/unresolve) — only the v0.1 trio.

## Consequences
- Unblocks M6 / #50 with a concrete, buildable, honestly-gated, human-in-the-loop shape.
- Introduces Squarewright's **first persistent state** + a **new trusted-zone write path** — hence this ADR and
  the three confirmations above (required before code lands).
- Sets up `src/feedback/` (capture + deterministic rollup + propose + regression-gate, unit-testable) with
  `Poster` writes; the signal taxonomy + gaming rules already live in
  [`design/feedback-and-data.md`](../design/feedback-and-data.md) and are referenced, not re-litigated.
