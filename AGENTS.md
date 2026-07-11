# AGENTS.md

The first file an AI agent (Claude Code, Codex, …) should read when working in this repo. It is the
**guardrails + standing maintainer rules** — *what must never happen* and *how we've decided to work*. It is
deliberately short and mostly points elsewhere so it doesn't drift.

- **How a work session actually runs** (the loop, the review gate, the Ready-issue format) → [`docs/WORKFLOW.md`](docs/WORKFLOW.md)
- **What we're building & why** → [`NORTH_STAR.md`](NORTH_STAR.md), [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/adr/`](docs/adr/)
- **Vocabulary** (Persona, Grounder, Assembly, Finding, …) → [`docs/CONTEXT.md`](docs/CONTEXT.md)
- **Provider / eval operations** (paths, endpoints, commands, limits) → ai-memory page `procedural/provider-and-eval-operations.md`
- **Reporting finished work to the maintainer** → [`docs/templates/agent-report.md`](docs/templates/agent-report.md)

## What this is (30 seconds)
Squarewright is the **assembly layer** for a repo-local AI code reviewer built on **Pi** (a borrowed agent
runtime). Pi owns the agent loop / providers / sessions; Squarewright owns the config, personas, routing,
GitHub posting, and evaluation. The AI is the reviewer; deterministic checks only feed or verify it. Pre-v0.1,
single maintainer, **public** repo.

## Hard rules — non-negotiable
1. **The trust boundary is sacred.** A review is split into `gather` (untrusted PR/fork context, **no
   secrets**, never executes PR-head code) and `review` (trusted, has secrets). Never blur them; never let a
   secret or PR-head execution reach the gather phase. The artifact head-SHA cross-check is mandatory.
2. **Grounder / Verifier / Policy never call an LLM.** That is their definition — they produce facts or run
   real tools (compile/test/grep). A "verifier" that re-reads text is not a verifier.
3. **Secrets never leave the machine.** Never print, echo, log, or commit an API key. Keys live *outside* the
   repo (see the ai-memory ops page for paths/env names — values are never stored). Assume everything
   committed here is world-readable forever.
4. **Money is guarded.** Never invoke a **paid** provider (OpenRouter) without an explicit spend cap *and*
   maintainer go-ahead; always through the shared spend guard; **no model loops**. Use **free z.ai** for
   iteration. **GLM only via z.ai, never OpenRouter.** **z.ai concurrency ≤ 5.** Two budgets were burned by
   reasoning-token traps — run the pre-spend check first.
5. **Measurement is honest.** Judge on real defect-match, not the file metric (it inflates ~2–4×). **Report
   ranges, not single points** — run-to-run variance is large; ≥3 runs before claiming a change. Never present
   a guess as a fact. Grounding is **off by default**; verify is **off by default**.

## Standing preferences — how we've decided to work
- **PR loop for agent-authored changes** (branch → subagent review → checks → maintainer merge). Trivial
  *human* edits may still go direct to `main`. Branch from `origin/main`, not local main.
- **Improve on references, don't copy them.** (Prior art like trimwire is input, not a template — adopt a
  pattern only if you can't do better.)
- **Don't bloat or bias subagents** — give them grounded context and a tight task, nothing leading.
- **Ask, don't guess.** Some forks are the maintainer's call, not yours — surface them as a crisp question,
  never bury one in prose or resolve it silently by picking an answer. The canonical list of these stop
  conditions lives in [`docs/WORKFLOW.md`](docs/WORKFLOW.md) under "Stop conditions — ask, don't guess".
- **All GitHub writes go through the `Poster` interface** (`gh api` is the first impl, swappable to Octokit) —
  never scatter raw `gh`/HTTP calls through the code.
- **Check `docs/adr/` before an architectural change; propose a new ADR before making one.**
- Match surrounding code. **Strict TypeScript — don't weaken `tsconfig`.** Commit messages: `type(scope):
  summary`, imperative, explain *why*.

## Engineering principles
- **Simple code.** Aim for code that (1) passes its tests, (2) expresses every idea it needs to, (3) says
  everything *once* (no duplicated knowledge), and (4) has no superfluous parts. These pull against each other;
  balance them for whoever maintains this next. Work in order — **make it work → make it right → make it
  fast** — and only once it works, pause to ask whether it should be made simpler or faster. Don't polish or
  optimize code that isn't yet correct.
- **Comments earn their place.** A comment that only restates the code is noise — delete it (applying the
  simplicity rules usually removes it for you). Keep the ones that explain *why*, a non-obvious constraint, or
  a decision the code can't show.
- **No historical framing.** Code, comments, and docs describe what *is*, never what changed — no "previously
  X, now Y", no "used to…", no changelog asides in source or docs. When a decision changes, rewrite the doc to
  state the new decision and delete the old; git history is the record. A change to a **big direction** needs
  maintainer approval before the doc is rewritten. (Dated records are the exception — `docs/adr/` decision
  records and `eval/RESULTS.md` exist to capture context and measurements over time.)
- **Tests protect the future.** A test earns its place by answering three questions: would it fail *today*
  (the code doesn't already do this)? will it pass when you're done? will it still catch a regression
  *tomorrow*? Write the test that guards a future change, not one that just echoes today's diff.
- **No pre-existing failures left behind.** There is no "not our job." For any failure you find, decide *where*
  to fix it: aligned with the current work → in this PR; small and off-topic → its own PR; large → a separate
  (possibly stacked) PR. Keep the software buildable, workable, maintainable, and valuable.
- **Estimate by complexity, never by time.** Don't say "quick fix" or "a day's work" — that reflects how long
  *humans* take. Describe scope instead: lines/files touched, surface area of behavior change, trust-boundary
  or public-API surfaces crossed, whether it needs eval/benchmarking.
- **Delegate with judgment.** For a coding task, run an appropriately-powered model in a subagent when it fits
  (cheaper for mechanical work, stronger for hard reasoning) — and always review the result yourself before
  trusting it. See `docs/WORKFLOW.md` for the review loop.

## Dev loop
- Install: `bun install`
- Verify a change: `bun run verify:pr` — the single gate (typecheck + tests + lint); CI runs it on every PR.
- Individually: `bun run typecheck` · `bun test` · `bun run check` (Biome via Ultracite; `bun run format` to fix)
- Run the CLI locally: `bun run dev -- <args>`
- Eval (free z.ai default): see the ai-memory ops page for the exact command + the pre-spend check.

## Project review rules (`.review-rules/`)
Repo-specific conventions the reviewer loads as **trusted, precedence-taking** context (ADR-0005 Tier A, M6).
Each `.review-rules/*.md` file carries `description`/`globs` frontmatter; the loader (`src/rules/review-rules.ts`)
selects the rules whose `globs` match a PR's changed files — deterministically, reusing the persona glob matcher,
**no LLM** — and prepends them to the review prompts. A rule that explicitly permits something a persona would
flag wins. Rules are maintainer-authored via a normal reviewed change (never auto-committed); when the reviewer
wants a new rule it posts the text as a suggestion to paste here, it does not write the file. **Trust:** rules
are read by `fsRepoReader` over the Review workflow's checkout — the **trusted default branch, never PR head**
(`squarewright-review.yml` is `workflow_run`-triggered, so a no-`ref` `actions/checkout@v4` resolves to the
default-branch tip, not `refs/pull/N/merge` — that trigger is the guarantee; the workflow adds a best-effort
PR-head-content tripwire as defense-in-depth) — so a head-revision rule added by an untrusted PR can't suppress
its own findings, and a new/edited rule applies from the **next** PR. The reader loads rules only;
it is NOT forwarded to the Worker (that would enable grounding tools — a separate off-by-default feature). This
repo dogfoods it via [`.review-rules/architecture.md`](.review-rules/architecture.md).

## Where things live
See the **Module layout** table in [`docs/ROADMAP.md`](docs/ROADMAP.md) — kept there as the single source, not
duplicated here.
