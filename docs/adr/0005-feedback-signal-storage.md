# ADR 0005 — How Squarewright improves over time (M6)

Status: Proposed · 2026-07-09

## Context

M6 is the North-Star differentiator: *"gets better from your feedback without ever changing itself behind your
back… any change to its own rules is proposed to you, never auto-applied"* ([`NORTH_STAR.md`](../../NORTH_STAR.md);
issue #50). Two hard constraints: **(1)** we don't own/train the model (Pi drives it) — "improve" means **assembly
tuning** (rules, personas, config), never fine-tuning; **(2)** **human-gated** — proposed, never silently applied.
**Scope: per-repo local** — each repo improves from its own use. (Cross-repo aggregate tuning of the *shipped*
defaults is a separate, later, opt-in tier — out of scope.)

**Origin + prior art.** Squarewright grew out of a Launch Potato reviewer (`launchpotato/artificial-intelligence-
central` `agents/code-reviewer.md` + `financebuzz` `claude-pr-review.yml`) whose "improve over time" is exactly
this: it loads **global rules** (a central repo) + **project rules** (`.cursor/rules/`, `AGENTS.md`, `docs/`) —
**project takes precedence** — reading only the ones relevant to the changed files; and it detects **rule drift**
(a `📖 rule-drift` finding proposing the exact rule text when a PR makes a rule stale or introduces an
undocumented pattern), which a human then ratifies. A sourced web survey confirms this is the *industry-universal*
mechanism (CodeRabbit, Cursor, Copilot, Qodo, Sourcery, Greptile all make a human-editable **rules file** the
primary customization layer; CodeRabbit dropped 👍/👎 for a *teach-by-reply* flow because thumbs get
sycophancy-hacked). Nobody ships an AI that *decides* rule changes; where AI touches learning it only *extracts*
what a human said or *summarizes* history. So the honest M6 is **rules + human-ratified rule growth**, not a
learning loop.

## Decision — M6 v0.1 (four parts, all shippable now; no LLM in any deciding path)

### 1. Layered project rules the reviewer loads per PR
A repo-committed **project rules** layer (`.review-rules/`, plus honoring `AGENTS.md`/`.cursor/rules/`/`docs/` if
present) that the reviewer reads on every review — loading **only** the rules relevant to the changed files
(glob/trigger match, like personas already route; don't read everything). **Project rules take precedence** over
Squarewright's shipped personas/rules: a project rule that explicitly permits something a persona would flag wins,
and a linter-disable comment suppresses a finding. This is the tuning surface the user owns and git-diffs.

### 2. Rule-drift / new-rule proposals — the primary "improve over time"
The reviewer detects when a PR **makes an existing rule stale** or **introduces a pattern that should be a rule**,
and **proposes the exact rule text** as a finding (a `rule-drift` inline comment with a ready-to-paste rule
block). The human adds/edits the rule file (a normal commit/PR). The rules corpus **grows from real reviews** —
proposal by the tool, ratification by the human. No storage, no auto-apply, no injection surface beyond the
already-human-gated merge.

### 3. Teach-by-reply
The user replies to a finding (`@squarewright …` / `/squarewright remember …`); a **permission-gated** (write/
maintain/admin only, PR author excluded) AI step **interprets** the reply into a candidate rule + confidence
(schema-constrained output — `{scope, rule_text, confidence}`; low-confidence dropped, not guessed; reply text is
treated as **data, never instruction**) and **opens a PR** appending it to the rules file. The AI *reads* the
user's intent; it never *decides* to change anything — the human merges. (This is the safe half of "AI weights
the signals": interpret input, never author authority.)

### 4. Read-only accept-rate / dismiss report
A report (computed live from GitHub's own reactions/resolved-state + two behavioral signals: a flagged hunk
changed in a later commit, a suggestion committed) showing per-rule/persona **accept-rate + sample size** — with
**fixed weights** (behavioral highest, 👍/👎 lowest, per CodeRabbit's anti-sycophancy lesson), **reported to the
human, never auto-gated on** (a metric optimized against is a metric gamed — Goodhart). The user prunes noisy
rules/personas themselves.

## Trust boundary
Rules are read and the reply-interpreter runs in the **trusted `review` zone**; `gather` never reads them. Reply
text and any rule text sourced (via a finding) from a third-party diff is **untrusted data, not instruction** —
delimited/quoted to the interpreter, permission-gated at the input, and **only ever a proposed diff a human
merges** (the merge gate is the injection defense; reliable text sanitization is unsolved).

## Deferred — the one *real* big thing
The **automated self-tuning pipeline**: a persistent signal-ledger branch, a deterministic accept-rate *rollup*,
a *regression gate*, **auto-opened** proposal PRs, AI-weighted signal aggregation, and any AI that *decides and
applies* changes. This is genuinely large + risky (persistent state, a new trusted write path, prompt-injection
and regression surfaces, and — per our own M5/M7 evidence — a golden corpus too noisy to gate per-repo tuning
against). It earns its place only **after** parts 1–4 are used on real signals and the volume justifies it.
Everything else ships in v0.1.

## Non-goals
No fine-tuning. No silent auto-apply (always a PR/edit the human makes). **No LLM in a deciding path** — AI only
*interprets* a reply (§3) or *drafts* a proposed rule's prose; the decision to change is always the human's. No
AI-weighted signal aggregation (fixed weights until data justifies otherwise — Google's *Rules of ML* #1). No
vector/RAG retrieval in v0.1. No cross-repo aggregate telemetry (separate opt-in tier).

## Decisions the maintainer should confirm
1. **Where project rules live** — standardize on `.review-rules/` (already scaffolded) and *also* honor
   `AGENTS.md`/`.cursor/rules/`/`docs/`, or a narrower set? (Product/API-shape.)
2. **Teach trigger** — `@squarewright` mention vs. a `/squarewright remember` command vs. both.
3. **Rule-drift output** — an inline `rule-drift` finding the human copies into a rule (LP-style, zero new
   surface) vs. the teach step opening a rules-file PR directly.

## Consequences
- Unblocks M6 cheaply and safely, grounded in Squarewright's own origin (Launch Potato) + the industry norm —
  and it *is* "a way to improve the tool as time goes" without the scary machinery.
- Builds on what exists: persona/glob routing (→ rule loading), `.review-rules/`, and the sticky+inline poster.
  New work: a rules-loading step in the review path, a `rule-drift` capability, the teach-by-reply interpreter
  (`src/feedback/`), and the read-only stats report.
- Keeps the automated self-tuner as a clearly-scoped *later* ADR, not a v0.1 obligation.

> **Process note:** after this rewrite, mine the origin references + a fresh council round; apply any suggested
> fixes and council again until it settles, before this moves to Accepted.
