# Squarewright — Roadmap

Authoritative direction: [`docs/adr/0001`](adr/0001-pi-centered-reviewer-assembly.md). This roadmap is scope,
not schedule. There is no rush to deploy a first version; correctness and the right architecture come before
adoption.

## North star

`squarewright init` creates a working, safe, customizable AI-reviewer assembly in a repo, driven by Pi.
Squarewright owns the assembly layer; Pi owns the agent runtime. Deterministic checks are optional
grounders/verifiers that feed or check the AI — never the product's center.

## Architecture

A review is a **pipeline of stages** over a PR, split across two trust zones for safety:

```
  ── untrusted zone (PR/fork context, no secrets) ──
  gather:   collect PR diff + metadata + CI signals  ──▶  artifact
  ── trusted zone (base-repo context, secrets) ──
  review:   load assembly ▸ route personas ▸ drive Pi ▸ collect findings
            ▸ verify/ground (optional) ▸ dedup ▸ post (sticky + inline) ▸ record feedback hooks
```

Module layout (see `src/`):

| Module | Responsibility |
|---|---|
| `cli/` | `init`, `review` (gather/post phases), `doctor` |
| `assembly/` | `.squarewright.yml` schema, loading, validation |
| `pi/` | Pi integration: session creation, custom-tool registration, model-lane policy |
| `personas/` | Persona definitions + routing/pairing/batching engine (glob → persona → lane) |
| `tools/` | Custom Pi tools: repo-inspect, ci-signal, post-comment |
| `github/` | GitHub API glue: PR files, checks/annotations, sticky + inline comments, reactions |
| `output/` | Finding schema, dedup/aggregation, markdown-injection-safe rendering |
| `safety/` | `workflow_run` trust-boundary helpers, artifact head-SHA cross-check |
| `feedback/` | Signal capture (reactions + implicit) and local tuning proposals |
| `grounders/` | Optional deterministic fact-finders (polyglot plugin contract) |
| `init/` | Scaffolder — emits workflows + config + rules from `templates/` |

## v0.1 — the smallest credible proof (dogfooded, not launched)

Goal: prove `init → a working repo-local AI reviewer on Pi`, then dogfood it on **big, ambiguous PRs from
famous repositories** (the same kind of corpus used before: lance / pandas / airflow / django / k8s / next /
playwright / prisma / tokio / clap / gin / axios). Not a public launch.

1. **`squarewright init`** — scaffolds the safe two-phase workflows, `.squarewright.yml` (provider + model +
   one persona), a `.review-rules/` seed, and provider-secret instructions. Generated files are **thin** and
   reference the versioned harness.
2. **Pi-driven review harness** — diff + persona system-prompt → findings via a **schema'd tool call** (not
   freeform-JSON salvage). Uses Pi as a library (`createAgentSession`).
3. **The safe workflow spine** — `workflow_run` gather/post split, secrets only in the post phase, artifact
   head-SHA cross-check. Non-negotiable.
4. **Output — sticky AND inline comments** (inline is in v0.1 by decision): sticky summary + inline line
   comments with correct diff-hunk line mapping, dedup, and markdown-injection defanging.
5. **Feedback loop (local, v0.1 set)** — 👍/👎 on findings (collaborator-weighted), flagged-line-changed-in-a-
   later-commit, suggestion-accepted, rolled up into a per-rule/persona accept-rate. See
   [`design/feedback-and-data.md`](design/feedback-and-data.md).
6. **Provider config** — delegate the mechanism to Pi; own the policy (which provider/model). Covers the
   beginner + provider-swap heights for free.

## v0.x — depth on the assembly

- Multi-persona routing/pairing/batching engine (correlated-pair batching, solo personas, docs-only gating).
- Rules memory with human-gated learning (rule suggestions → proposed PR, never auto-commit).
- @mention conversation + re-review-on-new-commit via Pi session fork/resume.
- Dedicated react-to-tune command; resolve/unresolve + minimized-comment signals.
- Repeated-dismissal → auto-proposed `.squarewright.yml` suppression diff.
- Optional deterministic **Grounder** plugin (polyglot, via the JSON contract).
- Verifiers (compile/test/grep confirmation of AI findings).

## Later — opt-in aggregate (improve the shipped tool)

- Anonymized, k-anonymized, numbers-and-enums-only telemetry (never code/diffs) to curate shipped default
  personas/prompts/routing. Opt-in, auditable schema. See the feedback design doc for the privacy design.

## Non-goals

- Not a hosted SaaS reviewer / not "another CodeRabbit."
- Not a deterministic static analyzer; no regex-finder optimization as roadmap.
- "No key required" is not the core promise.
- Not building our own agent loop / provider abstraction / session store (that is Pi's).
- Not chasing external adopters before the assembly is proven end-to-end.
