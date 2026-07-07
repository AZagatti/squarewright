# AGENTS.md

The first file an AI agent (Claude Code, Codex, …) should read when working in this repo. It is the
**guardrails + standing maintainer rules** — *what must never happen* and *how we've decided to work*. It is
deliberately short and mostly points elsewhere so it doesn't drift.

- **How a work session actually runs** (the loop, the review gate, the Ready-issue format) → [`docs/WORKFLOW.md`](docs/WORKFLOW.md)
- **What we're building & why** → [`NORTH_STAR.md`](NORTH_STAR.md), [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/adr/`](docs/adr/)
- **Vocabulary** (Persona, Grounder, Assembly, Finding, …) → [`docs/CONTEXT.md`](docs/CONTEXT.md)
- **Provider / eval operations** (paths, endpoints, commands, limits) → ai-memory page `procedural/provider-and-eval-operations.md`

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
- **Ask, don't guess**, on: the trust boundary, secrets, ADR-level decisions, golden-corpus ground truth, and
  product/API-shape choices. Surface the decision as a crisp question — don't bury it in prose or pick silently.
- **All GitHub writes go through the `Poster` interface** (`gh api` is the first impl, swappable to Octokit) —
  never scatter raw `gh`/HTTP calls through the code.
- **Check `docs/adr/` before an architectural change; propose a new ADR before making one.**
- Match surrounding code. **Strict TypeScript — don't weaken `tsconfig`.** Commit messages: `type(scope):
  summary`, imperative, explain *why*.

## Dev loop
- Install: `bun install`
- Verify a change: `bun run verify:pr` — the single gate (typecheck + tests + lint); CI runs it on every PR.
- Individually: `bun run typecheck` · `bun test` · `bun run check` (Biome via Ultracite; `bun run format` to fix)
- Run the CLI locally: `bun run dev -- <args>`
- Eval (free z.ai default): see the ai-memory ops page for the exact command + the pre-spend check.

## Where things live
See the **Module layout** table in [`docs/ROADMAP.md`](docs/ROADMAP.md) — kept there as the single source, not
duplicated here.
