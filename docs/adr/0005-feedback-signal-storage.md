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
central` `agents/code-reviewer.md` + `financebuzz` `claude-pr-review.yml`, read for this ADR) whose "improve over
time" is exactly this: it loads **global rules** (a central repo) + **project rules** (`.cursor/rules/`,
`AGENTS.md`, `docs/`) — **project takes precedence** — reading only the ones relevant to the changed files; and it
detects **rule drift** (a `📖 rule-drift` finding proposing the exact rule text when a PR makes a rule stale or
introduces an undocumented pattern), which a human then ratifies by editing the rule file. Notably LP **only ever
posts comments** — it never opens a PR to change rules itself. Public docs for CodeRabbit, Cursor, Copilot, Qodo,
Sourcery, and Greptile likewise make a **human-editable rules file** the primary customization layer, and
CodeRabbit's docs describe moving off 👍/👎 toward teach-by-reply because thumbs invite sycophancy/gaming (see
Sources). So the honest M6 is **rules + human-ratified rule growth**, not a learning loop.

## Decision — M6 v0.1 (four parts, all shippable now; no LLM decides a change)

### 1. Layered project rules the reviewer loads, relevant to the diff
Two tiers, deliberately different mechanisms:
- **Tier A — `.review-rules/*.md`** (maintainer-authored, `description`/`globs` frontmatter — the format the
  `templates/review-rules/` scaffold already documents). **Deterministic, zero-LLM:** reuse
  `src/personas/routing.ts`'s glob matcher to select the rules whose `globs` match the PR's changed files, and
  inject their text into the persona `systemPrompt`s. Same tested pattern as persona routing; no new tool, no new
  trust surface. **This is the first PR.**
- **Tier B — freeform docs** (`AGENTS.md`, `.cursor/rules/`, `docs/`, which carry no glob metadata): a Worker
  reads the ones relevant to the changed files using the `read_repo_file`/`list_repo_dir` Pi tools the analysis
  pass **already has** (`src/pi/worker.ts` `buildRepoTools`) — LP's exact "list dir, read what's relevant"
  mechanism, natively available because Squarewright runs on Pi (trimwire, a thin harness, couldn't). This is
  ordinary **context-gathering**, the same judgment Pass 1 already exercises reading files — *not* a deciding
  path, so it doesn't conflict with "no LLM decides a change." Fast-follow after Tier A.

**Precedence is prompt-framing, not a new primitive:** project-rule text is placed with an explicit "these
override conflicting persona guidance" instruction (as LP's "a linter-disable comment suppresses a finding" is
also model judgment, not a parser). A project rule permitting something a persona would flag wins.

### 2. Rule-drift / new-rule proposals — the primary "improve over time"
The reviewer proposes rule text (a `rule-drift` finding with a ready-to-paste block) when a PR makes an existing
rule stale or introduces a pattern that should be a rule; the human edits the rule file. **Anti-noise discipline
(so it isn't a proposal on every PR):** propose only if **no already-loaded rule (§1) already covers the
pattern**; **at most one rule-drift finding per persona-pass per PR**; subject to the **same dedup-on-repost** as
any finding (same-issue collapse in `src/output/aggregate.ts`; prior-comment clearing via `clearPriorInline` in `src/github/poster.ts`), so a re-review doesn't re-propose it. It's a
*finding a human chooses to act on* (not a write), so it needs no permission gate itself.

### 3. Teach-by-reply — an inline suggestion, not an auto-PR
The user replies to a finding (`@squarewright …` / `/squarewright remember …`); a **permission-gated** (write/
maintain/admin only, PR author excluded) AI step **interprets** the reply into a candidate rule (schema-
constrained `{scope, rule_text, confidence}`; low-confidence dropped; reply text treated as **data, not
instruction**) and **renders it as an inline suggestion the human copies into a rule file** (reuse the injection-
safe `renderInlineBody`/`mdSafe` in `src/output/render.ts`) — **it does not open a PR itself.** This matches LP
(comments only), needs **no new write path** (today's workflow has `pull-requests: write`, not `contents:
write`), and keeps auto-opened PRs in the deferred tier. The AI *reads* intent; the human makes the change.

### 4. Read-only accept-rate / dismiss report — bounded window
A report of per-rule/persona **accept-rate + sample size** with **fixed weights** (behavioral highest — a flagged
hunk changed in a later commit, a suggestion committed; 👍/👎 lowest, per the anti-sycophancy lesson), **reported
to the human, never auto-gated on** (Goodhart). Computed **live from GitHub over a bounded window** (last N
reviewed PRs / ~30 days): a single-window report is genuinely storage-free (GitHub's review-comment API returns
`diff_hunk` + inline `reactions`, so the content-hash is derivable at query time). An **unbounded growing trend**
is *not* "live" — it needs the deferred ledger/rollup; v0.1 is explicitly the bounded-window report.

## Trust boundary
Rules are read and the reply-interpreter runs in the trusted `review` zone; `gather` never reads them. Reply text
and any rule text sourced (via a finding) from a third-party diff is **untrusted data, delimited/quoted to the
model, permission-gated at the input** — and only ever surfaced as a suggestion a human acts on (the human step
is the injection defense; reliable text sanitization is unsolved). No part of v0.1 adds a trusted auto-write path.

## Deferred — the one *real* big thing
The **automated self-tuner**: a persistent signal-ledger branch, a deterministic accept-rate *rollup*, a
*regression gate*, **auto-opened** proposal PRs, AI-weighted signal aggregation, and any AI that *decides and
applies* changes. Genuinely large + risky (persistent state, a new trusted write path, injection/regression
surfaces, and — per our M5/M7 evidence — a golden corpus too noisy to gate per-repo tuning against). It earns its
place only **after** parts 1–4 are used on real signals and volume justifies it. Everything else ships in v0.1.

## Non-goals
No fine-tuning. No silent auto-apply. **No LLM decides a change** — AI only *interprets* a reply (§3), *drafts*
proposed rule prose, or *gathers* freeform-doc context (§1 Tier B); the decision to change is always the human's.
No AI-weighted signal aggregation (fixed weights until data justifies otherwise — Google's *Rules of ML* #1
spirit). No vector/RAG retrieval in v0.1. No cross-repo aggregate telemetry.

## Decisions the maintainer should confirm
1. **Where project rules live** — standardize on `.review-rules/` (Tier A) and *also* mine `AGENTS.md`/
   `.cursor/rules/`/`docs/` (Tier B), or a narrower set?
2. **Teach trigger** — `@squarewright` mention vs. a `/squarewright remember` command vs. both.
3. **Report window** — the bounded-window size for §4 (last N PRs / N days).

## Consequences
- Unblocks M6 cheaply and safely, grounded in Squarewright's own origin (Launch Potato) + the industry norm.
- **Builds on** working, tested mechanisms: persona/glob routing (`src/personas/routing.ts` → Tier A rule
  loading), the analysis pass's existing `read_repo_file`/`list_repo_dir` tools (→ Tier B), and the sticky+inline
  poster (`src/github/`). **Note:** `.review-rules/` today exists only as an `init` **scaffold template**
  (`templates/review-rules/`) copied into consumer repos — nothing reads it yet, and it isn't in this repo; the
  first PR scaffolds it into Squarewright and adds the loader that reads it (so we dogfood it).
- New work is small and staged: the Tier-A loader (first PR), then Tier-B mining, `rule-drift`, teach-by-reply,
  and the bounded-window report as independent fast-follows. The automated self-tuner stays a clearly-scoped
  *later* ADR.

## Smallest first PR
The **Tier-A deterministic rule loader**: scaffold `.review-rules/` into this repo; extend `routing.ts`'s glob
matcher to select `.review-rules/*.md` by `globs` frontmatter; inject matched rule text (framed as taking
precedence) into persona `systemPrompt`s in `src/assembly/review.ts`; unit-test that a non-matching-glob rule is
excluded and a matching one is included verbatim. Zero new trust surface, no LLM, no new Pi tool.

## Sources
Read for this ADR (external prior art, not our own measurements): Launch Potato `code-reviewer.md` +
`claude-pr-review.yml` (the origin); CodeRabbit Learnings docs (`docs.coderabbit.ai/knowledge-base/learnings`) +
"why emojis suck for RL"; Cursor Rules; GitHub Copilot custom-instructions; Qodo/PR-Agent best-practices; Sourcery
custom rules; Greptile learning. Academic: the many-shot-paradox and RLHF-sycophancy results. Full URLs are in
the session's web-research notes; treat all as directional prior art, never as Squarewright's own measured result.
