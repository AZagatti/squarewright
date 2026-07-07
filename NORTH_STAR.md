# North Star

**Assemble a genuinely good, honest AI code reviewer that lives in your repo, runs on any model, and you fully own.**

This is the product vision — the end state, not this week's work. For *scope and sequence* see
[`docs/ROADMAP.md`](docs/ROADMAP.md); for the *why* behind the shape see [`docs/adr/`](docs/adr/); for
*vocabulary* see [`docs/CONTEXT.md`](docs/CONTEXT.md).

## The end state

You drop Squarewright into a repository and, in minutes, have a working code reviewer that:

- **Runs on any model you point it at** — any of Pi's ~30 providers, cheap or frontier, hosted or local. The
  model is the reviewer; you choose it, and you can swap it without rewiring anything.
- **Reviews real, ambiguous pull requests** — the messy, judgment-heavy PRs from real projects, not toy
  snippets — and surfaces **grounded** findings: backed by a fact or a check, not a confident guess.
- **Posts like a good colleague** — a single sticky summary plus inline comments on the right lines, deduped
  across re-reviews, never spammy, safe against markdown injection from the diff.
- **Gets better from your feedback without ever changing itself behind your back** — 👍/👎 and implicit
  signals tune future reviews; any change to its own rules is proposed to you, never auto-applied.
- **Is honest about how good it is** — it measures itself on real PRs and reports real recall/precision,
  refusing a single flattering blended number. If it can't back a claim with measurement, it doesn't make it.
- **Is a toolbox, not a black box** — progressive disclosure from a low-friction start (add the GitHub Action
  *or* run `squarewright init`, set a model key) all the way to composing your own personas, routing, rules,
  grounders, verifiers, and model lanes. Two first-class onboarding paths, neither exclusive. You own every layer.

The reviewer *is* the AI, driven by [Pi](https://github.com/earendil-works/pi). Deterministic checks
(grounders, verifiers, policies) only ever **feed or verify** the AI — they are never the center of gravity.

## What it is deliberately not

- **Not a hosted SaaS reviewer** and not "a free CodeRabbit." It lives in *your* repo and runs on *your* runner
  with *your* model.
- **Not a deterministic static analyzer.** We do not optimize a regex/AST finder as the roadmap; determinism
  is an optional grounder, not the product.
- **"No key required" is not the promise.** An AI reviewer needs a runtime and a model. A no-key dry-run or
  local-model path may exist, but the honest default is: bring a model.
- **Not a rebuild of Pi.** We do not build our own agent loop, provider abstraction, or session store — that
  is Pi's job, and it does it well.
- **Not chasing adopters before the assembly is proven.** v0.1 is dogfooded on real PRs, not launched.

## How we'll know we're on course

The first real proof is **dogfooding**: Squarewright reviewing big, ambiguous PRs from famous repositories —
and eventually reviewing its *own* pull requests — with findings a maintainer would genuinely want, measured
honestly against a labeled corpus. Quality and the right architecture come before adoption; there is no rush
to launch.
