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
4. **Verify.** `bun run verify:pr` (typecheck + tests today; lint joins once Biome/Ultracite lands). If the change touches review quality
   (`personas/`, `pi/`, `output/`), also run the eval — **free z.ai only, ≥3 runs, behind the spend guard** —
   and record the delta in `eval/RESULTS.md`.
5. **Open a PR** with the template filled: briefing, *what you need from the maintainer*, subagent-review
   status, commands run, and a risk summary.
6. **Review gate runs** (below). Address must-fixes on the branch.
7. **Maintainer merges.** Close-out: update `eval/RESULTS.md` if measurement changed; write an ADR if a durable
   decision was made; `memory_consolidate` at session end.

## The merge gate (a chain, not a solo human read)

1. **Implementation agent** produces the change on a branch + the PR briefing and risk summary.
2. **Independent subagent review** — fresh context, adversarial (prompt below). Never grades its own homework.
3. **Automated checks** — `bun run verify:pr` locally (CI will run the same once wired, per ADR-0004).
4. **Squarewright dogfood** — *once the reviewer can post (roadmap M2+)*, Squarewright reviews its own PR. Until
   then this step is skipped and noted as such.
5. **Maintainer merge decision** — the final human gate.

## `bun run verify:pr` — the single verification target

One command an agent (or CI) runs to check a change, so nobody has to remember the individual steps. It wraps
typecheck + tests today, and grows to include lint once Biome/Ultracite lands (ADR-0004). Treated as the
pass/fail gate for a PR.

## Stop conditions — ask, don't guess

Stop and open a **crisp question to the maintainer** (in the PR's *"What I need from the maintainer"* section,
or before starting if it blocks the whole issue) whenever a task needs:

- **product or API-shape judgment** (a public interface, a CLI flag's behavior, a config schema choice),
- a **trust-boundary** decision (anything touching gather/review, secrets, permissions, the head-SHA check),
- a change beyond the issue's stated acceptance criteria or non-goals,
- a **paid** model run.

Never bury one of these in prose or resolve it silently by picking an answer. A wrong guess here can mean
throwing away a full implementation.

## Standard subagent-review prompt

Use this to spawn the independent reviewer in step 2 of the gate. Fill in `<PR / branch>` and the touched areas.

> You are an INDEPENDENT reviewer of a pull request in the Squarewright repo. You did NOT write this change —
> review it adversarially; do not rubber-stamp. Your job is to protect the maintainer from having to deeply
> self-review.
>
> Read the branch diff `<PR / branch>` and the ground truth it must respect: `AGENTS.md` (hard rules),
> `docs/CONTEXT.md` (vocabulary), the relevant `docs/adr/`, and the issue's acceptance criteria.
>
> Check specifically: (1) **correctness** — does it do what the issue asked, with the right edge cases?
> (2) **trust boundary** — does anything touch gather/review, secrets, permissions, or the head-SHA check
> incorrectly? (3) **non-goals & scope** — does it quietly do more than the issue, or reintroduce a documented
> non-goal? (4) **test/verify coverage** — is the behavior actually covered; does `bun run verify:pr` pass?
> (5) **honesty** — any claim (in code comments, the PR, or RESULTS.md) not backed by evidence?
>
> Output: **Verdict** (APPROVE / APPROVE-WITH-NITS / REQUEST-CHANGES); **Must-fix** (blocking, numbered, each
> with file + exact problem + suggested fix); **Nits** (non-blocking). Be concrete; quote the offending line.
> Do not modify files.

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
