# How we work — the agent development loop

How a work session on Squarewright actually runs. The hard rules live in [`AGENTS.md`](../AGENTS.md); this is
the *process*. Design goal: **move fast without turning a one-person project into process theater, and keep the
maintainer's manual load low.**

## Maintainer burden (what you do vs. what the agents do)

The point of this loop is that the maintainer is an **orchestrator**, not a line-by-line reviewer.

- **Maintainer owns:** direction (what to build, what matters), answering explicit blockers, and the final
  **merge / block** decision.
- **Implementation agent owns:** the implementation, running the local checks, the PR briefing, and a first
  **risk summary** (what's risky, what it's unsure about).
- **Independent subagent owns:** the review — a fresh, adversarial pass the implementer does not grade itself on.
- **The maintainer should not need to deeply self-review every diff.** If a PR reaches you needing a deep read
  to be safe, the loop failed upstream — the fix is a better subagent review or a tighter issue, not more of
  your time.

## The loop

1. **Orient (~5 min).** Agent reads `AGENTS.md`, skims ai-memory recent + the relevant ADR, and confirms which
   **Ready** issue it's taking (see the Ready-issue template below).
2. **Branch.** `git switch -c <type>/<slug>` from `origin/main`. Agent work never commits to `main`.
3. **Implement to the acceptance criteria.** Hit a **stop condition** → stop and ask (see below).
4. **Verify.** `bun run verify:pr` (typecheck + tests + lint). If the change touches review quality
   (`personas/`, `pi/`, `output/`), also run the eval — **free z.ai only, ≥3 runs, behind the spend guard** —
   and record the delta in `eval/RESULTS.md`.
5. **Open a PR** with the template filled: briefing, *what you need from the maintainer*, subagent-review
   status, commands run, and a risk summary.
6. **Review gate runs** (below). Address must-fixes on the branch.
7. **Maintainer merges.** Close-out: update `eval/RESULTS.md` if measurement changed; write an ADR if a durable
   decision was made; `memory_consolidate` at session end.

## The merge gate (a chain, not a solo human read)

1. **Implementation agent** produces the change on a branch + the PR briefing and risk summary.
2. **Independent subagent review** — a fresh, adversarial pass by the `sqw-reviewer` agent
   ([`.claude/agents/sqw-reviewer.md`](../.claude/agents/sqw-reviewer.md)). Never grades its own homework.
3. **Automated checks** — `bun run verify:pr` locally; CI runs the same on every PR.
4. **Squarewright dogfood** — *once the reviewer can post (roadmap M2+)*, Squarewright reviews its own PR. Until
   then this step is skipped and noted as such.
5. **Maintainer merge decision** — the final human gate.

**Review every big step, and loop.** Reviews are not only for the final PR — spawn `sqw-reviewer` on any
substantial step. If it returns `REQUEST-CHANGES` or blocking must-fixes, fix them on the branch and review
again; repeat until the verdict is `APPROVE` (or `APPROVE-WITH-NITS`, where nits are the author's call). Report
finished work using [`docs/templates/agent-report.md`](templates/agent-report.md).

## Milestone execution mode

When the maintainer approves a **milestone's direction** ("M1 is approved — continue"), the agent slices the
milestone into small PRs and opens them **without asking "go" before each one**, continuing until the milestone
is complete. This is the burden-reduction default: the maintainer sets direction and handles exceptions, not
per-step approvals.

Stop and surface a decision **only** for a real stop condition — those under "Stop conditions" below
(product/API-shape, trust-boundary, out-of-scope, paid-model spend), plus three that apply while running a
milestone unattended: **failed CI**, an independent review returning **REQUEST-CHANGES** that needs a direction
call, and **scope outside the milestone**.

Every PR still carries: what changed, a risk summary, the reviewer's result, commands/CI, and whether
maintainer input is needed — or "No maintainer decision beyond merge/block" when it isn't.

## `bun run verify:pr` — the single verification target

One command an agent (or CI) runs to check a change, so nobody has to remember the individual steps. It wraps
typecheck + tests + lint (Biome via Ultracite). Treated as the pass/fail gate for a PR, and CI runs it on
every PR.

## Stop conditions — ask, don't guess

Stop and open a **crisp question to the maintainer** (in the PR's *"What I need from the maintainer"* section,
or before starting if it blocks the whole issue) whenever a task needs:

- **product or API-shape judgment** (a public interface, a CLI flag's behavior, a config schema choice),
- a **trust-boundary** decision (anything touching gather/review, secrets, permissions, the head-SHA check),
- a change beyond the issue's stated acceptance criteria or non-goals,
- a **paid** model run.

Never bury one of these in prose or resolve it silently by picking an answer. A wrong guess here can mean
throwing away a full implementation.

## The reviewer

The independent reviewer is packaged as the `sqw-reviewer` agent
([`.claude/agents/sqw-reviewer.md`](../.claude/agents/sqw-reviewer.md)) — its system prompt, review dimensions,
and output format live there, so there's one source and no drift. Spawn it for step 2 of the gate; give it the
branch/PR under review, the touched areas, and the issue's acceptance criteria.

## Ready-issue template

An issue is not handed to an agent until every field is filled — this is the gate that keeps agent work on rails.

```
### Goal
One sentence: the outcome, not the steps.

### Context / background
Why this exists, which doc/ADR it traces to, and the EXACT existing files to reuse (paths) rather than
reinvent. Spell out any Squarewright-specific term on first use.

### Acceptance criteria
A short, checkable list — concrete function signatures / CLI behavior / file paths, not vibes.

### Evidence / checks
The exact command(s) that prove it's done (`bun run verify:pr`, `bun run scripts/eval.ts --id <case>`, …) and
what output counts as pass. Tie to unit tests for pure logic; tie to the eval for review-quality changes.

### Non-goals
What this issue explicitly does NOT do (the most common way agent issues balloon).

### Expected artifact
Which files change/are created, and what the PR should contain.

### Stop condition
The specific fork(s) where the agent must stop and ask instead of guessing (see "Stop conditions" above).
```
