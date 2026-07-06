# ADR 0002 — Positioning: a genuinely good, honest reviewer — on any model

Status: Accepted · 2026-07-06

## Context

It is tempting to headline "cheap model = expensive quality." That overclaims — people know cheap models
struggle to match strong ones, so the pitch invites skepticism and is easy to debunk.

## Decision

Frame the promise as **"being good is enough."** The reviewer is trustworthy because:

1. **Grounded quality** — it reasons over facts about the change (repo context, CI signals, optional
   grounders/verifiers), not diff-guesses. Model-agnostic is a *capability* ("runs on any model"), not the
   sales pitch.
2. **Honest measurement** — its real catch-rate on real, ambiguous PRs is reported straight, with no
   synthetic inflation and no single blended headline number.
3. **Easy setup** — `squarewright init` stands up a reviewer in minutes, not hand-rolled YAML plus a private
   instructions repo.

Headline: *"a code reviewer that's actually good, and honest about how good it is — on whatever model you
run."* Do **not** headline "cheap matches expensive."

## Consequences

- Marketing claims stay defensible.
- "Grounded = good" leads; model-agnosticism and cost are supporting capabilities.
- The three layers are sequenced: grounded quality first, honest measurement close behind (it proves "good"),
  easy setup throughout.
