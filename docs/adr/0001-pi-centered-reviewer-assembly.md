# ADR 0001 — Squarewright is a Pi-centered reviewer-assembly toolbox

Status: Accepted · 2026-07-06

## Context

Building an AI code reviewer for a real repo is not mostly a "call a model" problem — it is a workflow
problem. The hard, error-prone parts are everything *around* the model: a safe GitHub Actions setup (secrets
must never meet untrusted fork code), provider/key config, personas, model routing, rules memory, structured
output, sticky + inline comment posting, dedup, and review-maintenance. There is no open-source toolbox that
assembles these into a reviewer you own and run in your own repo.

## Decision

**Squarewright is an open-source toolbox for assembling a repo-local AI code reviewer on top of
[Pi](https://github.com/earendil-works/pi).** Pi is the engine; Squarewright is the assembly layer.

The key product promise: **`squarewright init` creates a working AI-reviewer assembly in a repo** — which the
user can then customize at any layer, or not at all.

### What Squarewright owns vs. what Pi owns

| Pi owns (delegate) | Squarewright owns (the assembly layer) |
|---|---|
| Agent loop, tool-calling contract, event stream | `squarewright init` — scaffolds a working reviewer into a repo |
| Provider abstraction, auth, ~30 providers + custom-provider hook | Provider/model **routing policy** + model lanes |
| Sessions: persist, fork, resume, compaction | PR lifecycle → sessions: re-review on new commits, @mention follow-up |
| Headless driving (SDK + RPC), system-prompt override | The safe two-phase (gather/review) CI workflow, secrets boundary, least-privilege perms, artifact head-SHA cross-check |
| Distribution as native binaries | Persona definitions + the routing/pairing/batching engine |
| Custom tools via `defineTool` / extensions | Custom review tools: repo-inspect, CI-signal grounding, post-comment |
| — | Output: sticky + inline posting, diff-hunk→commentable-line mapping, dedup, markdown-injection defanging |
| — | Structured-finding contract (schema'd tool-call output) |
| — | Rules memory + human-gated learning; the feedback/data loop |
| — | Optional deterministic **Grounders/Verifiers** that feed or check the AI |

### Substrate: TypeScript, using Pi as a library

Pi is a Node/Bun library. Squarewright's harness lives in Pi's ecosystem and uses Pi **as a direct library**
(`createAgentSession`, `defineTool`, session fork/resume) rather than shelling out to it — the reviewer's
custom tools (post-comment, ci-signal, repo-inspect) are themselves Pi tools, so a single ecosystem is both
simpler and more capable. The harness `bun build --compile`s to a **single native binary**, so end users need
no Node/Bun installed. A fast deterministic Grounder, if built, can be a separate polyglot plugin over the
JSON contract.

### Distribution shape

`squarewright init` scaffolds **thin** per-repo config + workflows that reference the **versioned**
squarewright harness/Action; the heavy logic stays upstream and upgradable, not frozen in generated code.
This is a toolkit delivered via an Action preset, scaffolded by `init`.

### Target-user spectrum (progressive disclosure, one toolbox)

1. **Beginner** — Marketplace Action / small YAML, add a provider-key secret, pick a preset → a decent reviewer.
2. **Provider-focused** — keep the harness, swap OpenRouter / Anthropic / company key / local model.
3. **Customizer** — edit personas, rules, model lanes, budgets, routing.
4. **Power user** — add/override tools, verifiers, grounders, posting, prompts, policies, runtime wiring.

These are heights on the same toolbox, not separate products.

## Non-goals

- Not a hosted SaaS reviewer; not "another CodeRabbit."
- Not a standalone deterministic static analyzer — deterministic pieces exist only as optional grounders/
  verifiers that feed or check the AI.
- "No key required" is **not** the core promise (a dry-run / local-model / demo path may exist, but the
  beginner path may require a provider key).
- Not building our own agent loop, provider abstraction, or session store — that is Pi's, unless Pi's
  governance/license deteriorates.
- Not chasing external adopters before the assembly is proven end-to-end on real, ambiguous PRs.

## Consequences

- The owned surface is the durable, novel layer (safe CI workflow, personas/routing, rules memory, output,
  feedback) — exactly what no existing OSS toolbox ships as a composable whole.
- One ecosystem (TypeScript + Pi), one native binary for users.
