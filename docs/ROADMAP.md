# Squarewright — Roadmap

Authoritative direction: [`docs/adr/0001`](adr/0001-pi-centered-reviewer-assembly.md). Product vision:
[`NORTH_STAR.md`](../NORTH_STAR.md). This roadmap is **scope, not schedule** — correctness and the right
architecture come before adoption; there is no rush to deploy a first version.

## North star (summary)

`squarewright init` — or a low-friction GitHub Action + config — stands up a working, safe, customizable
AI-reviewer assembly in a repo, driven by Pi. Squarewright owns the assembly layer; Pi owns the agent runtime.
Deterministic checks are optional grounders/verifiers that feed or check the AI — never the product's center.
Full vision in [`NORTH_STAR.md`](../NORTH_STAR.md).

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
| `core/` | Shared domain types (`Finding`, `ModelLane`, `Persona`, `ReviewContext`…) — the studs other modules build on |
| `cli/` | `init`, `review` (gather/post phases), `doctor` |
| `assembly/` | `.squarewright.yml` schema + loading; the `runReview` composer + post-phase orchestration |
| `pi/` | Pi integration: session creation, custom-tool registration, model-lane policy |
| `personas/` | Persona definitions + routing/pairing/batching engine (glob → persona → lane) |
| `tools/` | Custom Pi tools: repo-inspect, ci-signal, post-comment |
| `github/` | GitHub API glue: PR files, checks/annotations, sticky + inline comments, reactions |
| `output/` | Finding schema, dedup/aggregation, markdown-injection-safe rendering |
| `safety/` | `workflow_run` trust-boundary helpers, artifact head-SHA cross-check |
| `feedback/` | Signal capture (reactions + implicit) and local tuning proposals |
| `grounders/` | Optional deterministic fact-finders (polyglot plugin contract) |
| `init/` | Scaffolder — emits workflows + config + rules from `templates/` |

## Current bet — v0.1 (dogfooded, not launched)

Prove `init → a working repo-local AI reviewer on Pi`, then dogfood it on **big, ambiguous PRs from famous
repositories** (lance / pandas / airflow / django / k8s / next / playwright / prisma / tokio / clap / gin /
axios). Not a public launch.

The AI **engine** (two-pass Pi worker, personas, routing, aggregation, sticky/inline rendering, the eval
harness) already works — validated end-to-end by the eval harness, with unit tests on the output rendering and
diff-line mapping. The current bet is the **plumbing** that makes a real review *reachable* and *safely
postable*, then the depth that makes it good.

### Milestones

| | Milestone | Notes |
|---|---|---|
| **M1** | **Reachable review** — wire the working engine into `squarewright review` | the biggest single lever — exposes the proven engine (`scripts/eval.ts`) as `squarewright review --phase post`, which runs the review and prints findings. Posting them to GitHub is M2. |
| **M2** | **Safe posting** — a `Poster` interface (behind which `gh api` is the first impl, swappable to Octokit) + the artifact **head-SHA trust check** + sticky & inline comments | the trust-boundary half; the head-SHA cross-check is **non-negotiable** and **shipped** (`src/safety/trust.ts`: head-SHA match, single-open-PR guard, stacked-PR head filter; unit-tested), exercised live on this repo's own PRs |
| **M3** | **Re-review on new commit** — re-run on a new push and update the sticky comment in place (no spam) | early because a reviewer that reviews once is barely a reviewer |
| **M4** | **Onboarding — two first-class paths** | (a) **low-friction GitHub Action + config** (drop a workflow + `.squarewright.yml` pointing at the versioned harness); (b) **CLI binary + `init`**. Plus `doctor` + config loading. `init`+binary is **not** the only path. |
| **M5** | **Multi-persona routing / pairing / batching engine** | glob routing and solo/batched passes drive the eval and wire to `.squarewright.yml`. Correlated-pair batching is a config **primitive** (`pass` group-key), not a default: measurement showed batching is a directional single-model precision lever whose specific pairings aren't corpus-validated (no golden case co-touches two domains), so no default pairing ships — the primitive stays opt-in pending a multi-domain corpus case. Lands *after* the review → post → re-review path works. |
| **M6** | **Local feedback loop** — how the reviewer improves from your feedback | Decided in [ADR-0005](adr/0005-feedback-signal-storage.md). **§1 (reviewer loads your `.review-rules` + `contextDocs`) SHIPPED + measured** (#65/#66/#67; rules lift recall — synthetic 0/5→5/5, real 1/3→3/3, see `eval/RESULTS.md`). Remaining §2–4 (rule-drift, teach-by-reply, accept-rate) tracked in #50 + #70/#71/#72. Automated self-tuner **deferred**. Council (2026-07-10): recall (M7/#45) outranks §2–4 — a feedback loop needs a reviewer worth tuning first. |
| **M7** | **Honest measurement** — eval hardening + the cheap-model rank on the locked setup | **Shipped: free default structurer** (PR #48, cost fix). **First judged rank (2026-07-09) — a lead, NOT a result: the numbers don't reproduce** (glm-5.2 spans 2–8 across audits; the judge is itself stochastic). Robust: glm-5-turbo is the *worst* (0–1/12); reasoning rescues weak models. Exact rank unestablished. See `eval/RESULTS.md` + [`reference/models-reasoning-and-cost.md`](reference/models-reasoning-and-cost.md). **The dogfood/scaffold default review lanes run free z.ai `glm-5.2` reasoning-off — a *provisional, pre-v0.1 test-config* pick (off the robust-worst glm-5-turbo, not a measured-best), NOT the eventual product-release default.** The **real** release default is a separate future study (product-safe; if OpenRouter, cheap through the *whole* pipeline), still gated on the reproducible re-measure (analysis repeats × judge re-scores, pinned/different-family judge, ci-moby fixed) — issue #49. **Harness shipped** (judge `--judge-repeats`, cross-family judge, analysis×judge `--reports` matrix — this session); only **AC4, the re-measure itself**, remains before a default change. Recall (~1–2/12) is the live bottleneck — #45. |

The low-friction Action/config path from M4 is also the vehicle that runs M1–M3 in CI for dogfooding, so a
minimal version of it lands alongside M1–M2; M4 is the polish that makes **both** onboarding paths first-class.

## Follow-ups from the 2026-07-09 measurement session

Concrete, tracked items the model-rank/reasoning/cost session surfaced (full context: `eval/RESULTS.md`,
[`reference/models-reasoning-and-cost.md`](reference/models-reasoning-and-cost.md)):

- **Default review model (provisional, not settled).** The dogfood/scaffold review lanes run free z.ai `glm-5.2`
  reasoning-off (maintainer-directed): *off the robust-worst* glm-5-turbo, safe because this is pre-v0.1 test config with no
  external users — **not** a claim glm-5.2 beats glm-4.5 / deepseek-v3.2 (all tied at one draw; glm-5.2 itself re-judged
  2–8). The structurer stays free glm-5-turbo. The **real product-release default** is a separate future study (product-safe;
  cheap end-to-end if OpenRouter) and still needs the reproducible re-measure — **≥3 analysis repeats × multiple judge
  re-scores, a different-family judge** (issue #49, AC4) — before it's chosen. The re-measure **harness shipped** this
  session (judge repeats + cross-family judge + `--reports` matrix); the cheapest next step is running it on the
  current default glm-5.2 for an honest committed interval before treating any dogfood finding as representative.
  **AC4 RAN 2026-07-14 (eval/RESULTS.md):** current default glm-5.2-off DEFECT recall = **5–5–6/12** over 3 analysis
  repeats, judged cross-family — but **NOISY, not reproducible**: 5/12 loci (42%) flip hit/miss between identical runs,
  so a single dogfood run is NOT representative (report an interval; expect per-locus movement). The mechanical
  `deepseek-v3.2` judge was unreliable thinking-off (81/81 tool-drop, $0); the documented cross-family subagent judge
  was used instead. The per-locus flip re-motivates self-consistency (`--samples`): union of the 3 runs ≈ 8/12.
  Choosing the eventual *paid* release default, and investing in a more reliable mechanical judge, remain maintainer calls.
- **Harden the OR spend guard against retry re-billing** — the token estimate counts only the final attempt's usage, so
  throttle-driven retries (which re-send context and re-bill) undercount real spend. (It does NOT miscount reasoning tokens
  — Pi's `usage.output` already includes them.) Until then, bound OR reasoning cost with `max_tokens` at the source and
  don't over-parallelize a rate-limited provider.
- **Improve the structurer** — even free, it runs every pass. Options: default it to the cheapest configured lane's
  provider (coherent with any setup, not hardcoded z.ai); save the pass-1 analysis text to reports so structurer models
  can be compared **offline** without re-running analysis.
- **Self-consistency sampling** (`--samples`/`--consensus`, shipped as an eval knob) is a real recall lever (union
  recovers "reachable but rare" misses) — evaluate promoting it to the review path, per-model, with a precision guard.
- **Recall is the bottleneck** (issue #45) — an informal read of the sampling runs suggested most misses are model-ceiling / reachable-but-rare (not yet persisted as an artifact — #45 AC1),
  not routing/prompt gaps; grounding tested, didn't help the reasoning-bound cases.

## Recall & the model lever — the honest current picture (2026-07-16)

Every **zero-spend, agent-liftable** recall/precision lever has been pulled or dropped with measured evidence
(union, self-consistency, agentic grounding, similar-files, stronger structurer, divergence, calibration
anchors, blind bulk `learn`) — see `eval/RESULTS.md`. The free-key default (`glm-5.2`, reasoning-off) sits at a
noisy ~5/12 defect recall. The one proven ~2–4× lever is a **stronger analysis model** (grok-4.5 8–9/12; even
the cheapest gpt-5.4-mini roughly doubles free-glm).

**What changed:** a stronger model is **not** locked behind per-token paid API spend. Strong models are
reachable **at flat-fee via subscription headless-CLI agents** — `codex-exec` (GPT-5.6…), `grok-headless`
(grok-4.5), `claude-headless` (Opus/Sonnet/Haiku), `agy-headless` (Gemini / Claude / GPT-OSS via one login);
router: `/headless-delegate`. These already serve as the eval **instruments, judges, and council** members, and
the model rank was measured with them. So strategy is **not** limited to `glm-5.2`, and lifting recall is not a
"wait for a money decision" — it splits into two live tracks:

1. **Measurement** — freely runnable now across the fleet (many models × efforts × setups), no per-token cost.
2. **A shipped product path — the open design fork:** should Squarewright drive a subscription headless CLI as
   an **analysis backend / model lane**, so strong-model recall becomes a path a user can actually ship, not
   only an eval instrument? This is **ADR-level and trust-boundary-sensitive** (the trusted `review` phase
   driving an external agent that itself runs a shell) — it must be grilled and proposed as an ADR, not built
   blind. See the "provider-lane" thread. The product's **zero-config default stays free `glm-5.2`** (North
   Star: works with a free key, no setup); this lane would be opt-in.

**Money discipline is unchanged** (AGENTS.md Hard Rule #4): per-token **paid API** providers (OpenRouter) still
require an explicit cap + go-ahead. The subscription CLIs are the flat-fee path; OpenRouter is not.

## Later bets — v0.x depth

- **@mention conversation** + threaded follow-ups via Pi session fork/resume.
- **Rules memory with human-gated learning** — rule suggestions → proposed PR, never auto-commit.
- Dedicated react-to-tune command; resolve/unresolve + minimized-comment signals.
- Repeated-dismissal → auto-proposed `.squarewright.yml` suppression diff.
- Optional deterministic **Grounder** plugin (polyglot, via the JSON contract).
- **Verifiers** (compile/test/grep confirmation of AI findings) — only where they earn their cost.
- **Subscription-CLI analysis lane (the "provider-lane" fork)** — an opt-in model lane that drives a
  subscription headless-CLI agent (Codex / Grok / Claude / Antigravity) as the analysis backend, turning the
  proven strong-model recall lever into a shippable path at flat-fee. ADR-level + trust-boundary-sensitive
  (review-phase driving an external agent that runs shell); grill + ADR before build. See the recall section
  above.

## Later — opt-in aggregate (improve the shipped tool)

- Anonymized, k-anonymized, numbers-and-enums-only telemetry (never code/diffs) to curate shipped default
  personas/prompts/routing. Opt-in, auditable schema. See the feedback design doc for the privacy design.

## Parking lot (explicitly not committed)

- GitHub **Marketplace Action / published-binary** distribution (the review template references a not-yet-
  published `@v1`).
- **Final model ranking** — current numbers are directional; run-to-run variance is large.
- **Grounding "rescue"** on stronger analysis models (as first wired it hurt precision; see `eval/RESULTS.md`).
- **Verify-by-default** on noisy models (measured; not worth it at the current operating point).
- Anything **Rust/WASM** — dropped.

## Non-goals

- Not a hosted SaaS reviewer / not "another CodeRabbit."
- Not a deterministic static analyzer; no regex-finder optimization as roadmap.
- "No key required" is not the core promise.
- Not building our own agent loop / provider abstraction / session store (that is Pi's).
- Not chasing external adopters before the assembly is proven end-to-end.
