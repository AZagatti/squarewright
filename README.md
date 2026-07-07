# Squarewright

**An open-source toolbox for assembling your own repo-local AI code reviewer — on top of [Pi](https://github.com/earendil-works/pi).**

Squarewright is **not** another hosted SaaS reviewer, not "a free CodeRabbit," and not a deterministic static
analyzer. It is the **assembly layer**: the safe GitHub workflow, provider/key config, personas, rules
memory, output posting, and feedback loop you would otherwise hand-roll to turn a language model into a
trustworthy PR reviewer that lives *in your repo* and that you fully own.

> **Status: pre-v0.1, in active construction.** The direction below is set (see
> [`docs/adr/0001`](docs/adr/0001-pi-centered-reviewer-assembly.md)); the harness is being built. This repo is
> being developed openly, not yet released for general adoption.

## Why

The maintainer hand-built an AI reviewer in [trimwire](https://github.com/AZagatti/trimwire) and hit the wall
this project exists to remove: there was **no toolbox** for the workflow *around* the model. You have to
hand-roll — and it is dangerously easy to get subtly wrong — the `workflow_run` trust boundary (secrets vs.
untrusted fork code), the artifact head-SHA cross-check, provider/model lanes, persona routing, rules memory,
JSON output contracts, sticky + inline comment posting, dedup, and review-maintenance rules.

Squarewright's job: **`squarewright init` creates a working AI-reviewer assembly in your repo** — and you can
customize any layer of it, or nothing.

## The split: Pi is the engine, Squarewright is the assembly

Squarewright delegates the hard, churny runtime problem to Pi and owns the reviewer product around it.

| Pi owns | Squarewright owns |
|---|---|
| Agent loop, tool-calling, sessions, ~30 providers + custom-provider hook, headless driving | `squarewright init` scaffolding |
| Provider/auth mechanism, native-binary distribution | The **safe** two-phase CI workflow, secrets boundary, artifact trust cross-check |
| System-prompt override, custom tools (`defineTool`) | Personas + routing/pairing, rules memory, model-lane **policy** |
| Session fork/resume (for @mention + re-review) | Output: sticky + inline comments, diff-line mapping, dedup, markdown-injection safety |
| — | Feedback/data loop (👍/👎 + implicit signals) to self-tune reviews |
| — | Optional deterministic **Grounders/Verifiers** that feed/check the AI |

## Who it's for (progressive disclosure, one toolbox)

1. **Beginner** — copy a small YAML / add the Action, set a provider-key secret, pick a preset → a decent PR reviewer.
2. **Provider-focused** — keep the harness, swap OpenRouter / Anthropic / a company key / a local model.
3. **Customizer** — edit personas, rules, model lanes, budgets, routing.
4. **Power user** — add/override tools, verifiers, grounders, posting, prompts, policies, runtime wiring.

## `squarewright init` will scaffold

- `.github/workflows/…` — the safe two-phase (gather / review) workflow, or a Marketplace Action config
- `.squarewright.yml` — the reviewer assembly config (provider, model, personas, routing, budgets)
- `.review-rules/` (or equivalent) — repo-specific rules memory
- default personas + model lanes, Pi runtime config
- provider-secret setup instructions + least-privilege GitHub permissions
- sticky + inline PR-comment setup
- optional grounders/verifiers

## Model-agnostic, key required (mostly)

The reviewer runs on whatever model you point it at (any of Pi's ~30 providers, or a custom/local endpoint).
"No key required" is **not** the core promise — an AI reviewer needs a runtime and a model. A no-key path may
exist as a dry-run, a local-model path, or a deterministic-only demo, but the beginner path may require a
provider key.

## Design & decisions

- [`NORTH_STAR.md`](NORTH_STAR.md) — **the product vision** (the end state we're building toward)
- [`docs/adr/0001`](docs/adr/0001-pi-centered-reviewer-assembly.md) — **foundational decision** (identity, what we own vs Pi, substrate, non-goals)
- [`docs/CONTEXT.md`](docs/CONTEXT.md) — glossary / ubiquitous language
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — current bet, milestones, later bets, parking lot, non-goals
- [`docs/design/feedback-and-data.md`](docs/design/feedback-and-data.md) — the feedback/data-signal strategy
- [`docs/adr/`](docs/adr/) — the decision record

## License

MIT © André Zagatti
