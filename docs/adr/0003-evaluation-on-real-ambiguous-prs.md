# ADR 0003 — Evaluate on real, ambiguous, multi-stack PRs from famous repos

Status: Accepted · 2026-07-06

## Context

The reviewer must be judged on the work it will actually face: real pull requests, not toy diffs. A
model-agnostic tool needs evidence across stacks, not one language, and on *ambiguous* changes where judgment
matters — the cases a diff-guessing reviewer gets wrong.

## Decision

Assemble a **multi-stack evaluation corpus of real, ambiguous PRs from well-known open-source projects**
(e.g. across Python, Rust, Go, TypeScript/JS — lance / pandas / airflow / django / kubernetes / next.js /
playwright / prisma / tokio / clap / gin / axios and similar), sourced fresh via `gh pr diff`.

1. Bias the corpus toward the hard classes: subtle regressions, dropped coverage, renamed public API with
   remaining callers, untested branches.
2. Keep **real** and any **synthetic** cases structurally separate (feeds honest measurement — ADR-0002).
3. Ground-truth labels get a second verification pass before they count.

This is the dogfood plan: run the assembled reviewer against these PRs, measure real recall/precision, and
iterate. Not a launch — a proof.

## Consequences

- Evidence generalizes across stacks (credible for a model-agnostic tool).
- The corpus doubles as a regression harness as the assembly evolves.
- Label quality is the main risk — mitigated by the verification pass and by preferring real merged-fix PRs
  with checkable outcomes.
