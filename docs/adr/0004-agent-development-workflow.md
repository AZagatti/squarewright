# ADR 0004 — How we develop Squarewright with AI agents

Status: Accepted · 2026-07-07

## Context

Squarewright is built largely *by* AI coding agents, by a single maintainer, in a public repo. The spike phase
(validate the reviewer's direction) is ending; the next phase is conventional wiring that agents are well
suited to. That shifts the need from "research harness" to a **repeatable way to hand work to agents and land
it safely without the maintainer deep-reading every diff.** We surveyed established practice (eval-driven
development, agent-ready issues, PR briefings, review/verify loops) and one team-scale reference
(`agent-loop-setup`), then challenged the result to strip anything that is process theater for one person.

## Decision

Adopt a two-layer operating system and a low-ceremony agent loop.

1. **Product direction is a first-class, separate layer:** [`NORTH_STAR.md`](../../NORTH_STAR.md) (vision),
   `docs/ROADMAP.md` (current bet / milestones / later bets / parking lot / non-goals). Kept apart from the
   engineering process so direction doesn't drift into how-to.
2. **Agent instructions split by purpose:** `AGENTS.md` holds only **guardrails + standing rules** (and a
   repo-root `CLAUDE.md` points to it); `docs/WORKFLOW.md` holds the **session loop, the review gate, and the
   Ready-issue template.** Each file stays single-purpose and mostly links out to avoid duplication drift.
3. **Agent-authored changes go through a PR loop** (branch from `origin/main` → PR); **trivial human edits may
   go direct to `main`.** Not everything is a PR — that would be theater for one maintainer.
4. **The merge gate is a chain, not a solo human read:** implementation agent → **independent subagent review**
   (adversarial, fresh context) → automated checks (`bun run verify:pr`, mirrored in CI) → **Squarewright
   dogfood** (once the reviewer can post, roadmap M2+) → **maintainer merge decision.** The maintainer is an
   orchestrator; if a PR needs a deep self-review to be safe, the loop failed upstream.
5. **Stop-and-ask is explicit:** product/API-shape, trust-boundary, out-of-scope, or paid-model decisions must
   be surfaced as a crisp question, never guessed or buried in prose.
6. **Tooling is minimal and deterministic:** Biome via the Ultracite preset (AI-code-generation consistency),
   `lefthook` pre-commit, and CI running typecheck + tests + lint. **The eval is not a CI gate** — it is paid,
   noisy (large run-to-run variance), and needs a secret in a public repo; it stays a manual, guarded,
   pre-merge step.

## Non-goals

- Not adopting a heavyweight spec/issue framework (GitHub Spec-Kit) or an external tracker with claim-locking
  and a multi-agent queue-drain runner — those solve a team/parallel-agent problem we don't have.
- Not adding `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `CODEOWNERS` / commit-lint — premature for a solo,
  pre-v0.1 repo not yet seeking outside contributors.
- Not gating merges on the eval, and not running paid models in CI.

## Consequences

- A new contributor or agent has one entry point (`AGENTS.md`) and one process doc (`docs/WORKFLOW.md`).
- The maintainer's load drops to direction + blocker answers + the merge decision; review rigor moves to an
  independent subagent and, later, to Squarewright reviewing its own PRs (the north-star dogfood).
- Main risk: the docs are load-bearing only if kept in sync — mitigated by making each file link to a single
  source (e.g. the module table lives once, in `docs/ROADMAP.md`) rather than restating it.
- The eval staying out of CI means review-quality regressions are caught by discipline (the workflow's
  ≥3-run rule), not automation — an accepted trade for cost and honesty.
