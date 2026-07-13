---
title: The pieces (vocabulary)
description: Personas, Grounders, Verifiers, Policies, Lanes — the Bricks you compose.
---

Squarewright is composed of small pieces ("Bricks") with clear jobs:

- **Persona** — a review lens (Correctness, Security, CSS, Docker, CI…). A prompt + a model lane + routing rules.
  The AI *is* the reviewer, driven by [Pi](https://github.com/earendil-works/pi).
- **Lane** — a named `(provider, model, reasoning)` target a persona routes to. Mechanism is Pi's; the *policy*
  (which lane, which model) is yours.
- **Grounder** — an optional **deterministic, no-LLM** step that injects facts for the model to reason from.
- **Verifier** — an optional check that **refutes** a candidate finding (a precision lever).
- **Policy** — deterministic rules that gate or shape output.
- **Rules memory** — Tier-A `.review-rules/*.md` (precedence-taking) + Tier-B context docs, loaded from the trusted
  base revision.

Grounders, Verifiers, and Policies only ever **feed or check** the AI — they are never the center of gravity.
