# ADR 0005 — Feedback signal storage & the learning mechanism (M6)

Status: Proposed · 2026-07-09

## Context

M6 — the "local feedback loop" — is the North-Star differentiator: *"gets better from your feedback without
ever changing itself behind your back… any change to its own rules is proposed to you, never auto-applied"*
([`NORTH_STAR.md`](../../NORTH_STAR.md)). It has sat blocked on one undecided question — **where do feedback
signals live, and how do they actually improve reviews?** ([`ROADMAP.md`](../ROADMAP.md) M6; issue #50).

Two hard constraints shape everything:

1. **We do not own or train the model** — Pi drives a swappable third-party LLM. So "improve" can **never** mean
   fine-tuning. Improvement is only ever **assembly tuning**: `.squarewright.yml`, persona prompts, rules,
   curated examples.
2. **Human-gated.** A change to the reviewer's own behavior is **proposed** to the maintainer as a diff, never
   auto-applied. (An auto-committed rule/prompt is a prompt-injection vector — see
   [`design/feedback-and-data.md`](../design/feedback-and-data.md).)

Grounding: a 3-member design council on this repo's docs, a web survey of production reviewers (CodeRabbit,
Qodo/PR-Agent, Greptile, Sourcery, Bito, Graphite) and academic prior art (DeepCRCEval; the many-shot-paradox
result; Reflexion/TextGrad), plus the trimwire reference the maintainer recalled. **Finding: nobody
fine-tunes** — every shipped "learning" mechanism is either prompt-injected rules from mined feedback or a
retrieval filter over embedded feedback. And **every comparable tool auto-applies its learned change**; only
CodeRabbit even offers an approval delay. Squarewright's mandatory human gate is therefore an *above-industry-
norm* safety stance, not table stakes — a deliberate differentiator worth stating outright.

## Decision

### 1. Storage — a dedicated, anonymized signal ledger on a git branch
Persist derived signals to a dedicated orphan branch (e.g. `squarewright-signals`), **never merged to `main`**.
(It's a per-event, PII-stripped *ledger* — the statistical *aggregation* into accept-rates happens downstream in
the Rollup stage, not at the storage layer.)
This keeps the ledger fully diff-auditable (the enforcement of "never behind your back") without polluting
`main`'s history — an established CI pattern (`benchmark-action/github-action-benchmark` stores time-series
this way), and the improved shape of what trimwire did.

- **Split raw vs. derived.** GitHub already durably stores raw explicit signals (👍/👎, resolved-state) — read
  those live via the API, don't duplicate them. Only **derived** data lives on the branch, because GitHub has
  no representation of it and it must survive PR close / force-push / ephemeral runners.
- **Anonymized, never PII.** `{rule_id, persona_id, glob/lang bucket, content_hash, outcome, observed_at}`
  — no usernames, paths, line numbers, message text, or code. The repo is **public**; a branch is exactly as
  world-readable as `main`, so the design doc's "strictly local" tier must meet its own *aggregate* privacy bar.
- **Improve on trimwire (per AGENTS.md "improve on references, don't copy them"; trimwire's internals below are
  from the maintainer's recollection, not re-verified against its source):** key findings by **content-hash of
  the flagged hunk** (survives force-push; trimwire reportedly keyed on comment-id/line, which our own gaming
  section flags as fragile); **permission-gate** classification (count only write/maintain/admin reactors,
  exclude the PR author); route every write through the **`Poster`** interface
  (not raw `gh`/`git` in YAML); publish a **versioned schema**; and **compact** old raw detail into rollups so
  clone size stays bounded.

### 2. The learning mechanism — three human-gated stages (no LLM in the deciding path)
1. **Capture** (trusted `review` zone, the pipeline's "record feedback hooks" step). Each posted comment carries
   a hidden marker (`rule`/`persona`/`content-hash`; `Finding.source` already exists). A scheduled job mines
   reactions/replies/resolved-state **and** the two implicit wins from the design doc — a flagged hunk's hash
   disappearing in a later commit (accept), a suggestion committed verbatim (strong accept) — permission-gated,
   appended to the branch. Pure observation, **no gate**.
2. **Rollup** (deterministic — a Policy/Grounder, **never an LLM**, per AGENTS.md rule 2). Per
   `{rule_id, persona_id, glob}`: accept-rate + sample size over a rolling window → *suppression* candidates
   (repeated rejects) and *persona-strengthening* candidates (repeated accepts), above a minimum-evidence floor.
3. **Propose** (the differentiator). Over a threshold, draft **one small diff** to `.squarewright.yml` / persona
   files with the evidence (numbers, content-hashes — never raw text) in the PR body, opened as a **normal PR
   off `main`** that the maintainer merges like any other. **Never auto-applied.**

### 3. "Strengthen persona" proposals carry curated few-shot exemplars
When the rollup proposes strengthening a persona, the diff attaches **2–5 curated accepted findings as few-shot
exemplars** in the persona prompt — not just an abstract instruction. This is a plain, human-approved diff (no
new infra) and matches the strongest evidence (DeepCRCEval's exemplar baseline; the many-shot-paradox result
that small curated sets beat both zero-shot and "dump everything"). Each proposal adds 2–5; the **cumulative
cap is ~≤25 exemplars per persona** (across supersessions — see §4), because quality degrades past that.

### 4. Supersession, not accumulation
A new proposal that contradicts or duplicates an existing rule/exemplar **replaces** it; it never stacks.
CodeRabbit's docs report that unbounded natural-language "learnings" produce conflicting, inconsistent behavior;
the many-shot result is the quantitative twin. Structured, versioned `.squarewright.yml` + a supersession rule
is our defense against that failure mode.

### 5. Deferred: retrieval/embeddings (v0.x, not v0.1)
Greptile/Sourcery's embedding-filter-over-feedback is the best-*evidenced* result (Greptile reports address-rate
19%→55%) but needs a vector store + embedding pipeline. It stays deferred to the roadmap's "Later — opt-in
aggregate" tier; the config-diff + curated-exemplar mechanism above is the cheap, fully-auditable, human-gated
v0.1 that composes with our trust model.

## Trust boundary
Signals are **captured and persisted only in the trusted `review` zone** (same tier as secrets / the head-SHA
check). The signals branch is **never checked out or read by `gather`** — a fork PR must not read or spoof prior
feedback. Raw signals originate in the public/untrusted PR zone, so they are **permission-gated before** they
influence any tuning. This is Hard Rule 1 applied, not a new exception.

## Decisions the maintainer must confirm (before implementation)
These are product/trust-shape calls, deliberately left open for sign-off rather than defaulted:

1. **Proposal trigger + threshold** — auto-drafted on a schedule vs. maintainer-dispatched only; and the
   evidence floor / accept-rate threshold that fires a proposal (how *eager* the tool is to touch its own
   config). *Council lean: dispatch-or-scheduled is fine; start conservative (e.g. ≥3 signals, ≥N sample).*
2. **Write scope** — grant the trusted `review` workflow `contents: write` (scoped to the signals branch +
   proposal PR-branches, never `main`) **vs.** a narrower path: a dedicated fine-grained token / GitHub App, or
   capture-only-now-with-writes-deferred. *Council lean: the branch-scoped `contents: write` is acceptable
   because it never writes `main` directly and every rule/prompt change still lands as a maintainer-merged PR —
   but this widens the trusted zone's blast radius, so it's your call, not a default.*
3. **Poll model** — a new scheduled (`schedule: cron`) workflow vs. piggybacking capture onto the existing
   `workflow_run` review trigger. *Council lean: scheduled, low-frequency, mirroring the "propose suppression"
   flow.*

## Non-goals
- **No fine-tuning** (we don't own the model). **No auto-apply** (always a proposed diff). **No vector store /
  RAG in v0.1** (deferred). **No free-text "learnings" accumulation** (structured + superseding instead). **No
  cross-repo telemetry** here — that's the separate, opt-in "Later — opt-in aggregate" tier.

## Consequences
- Unblocks M6 / #50 — the flagship differentiator gets a concrete, buildable, human-gated shape.
- Introduces Squarewright's **first persistent state** and a **new trusted-zone write path** — hence this ADR,
  and hence the three confirmations above are required before code lands.
- Sets up `src/feedback/` (capture + deterministic rollup, unit-testable) + `Poster` writes; the design detail
  (marker format, gaming/integrity rules) already lives in [`design/feedback-and-data.md`](../design/feedback-and-data.md)
  and is referenced, not re-litigated, here.
