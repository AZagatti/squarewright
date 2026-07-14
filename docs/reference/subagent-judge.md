# Fast defect judge via a Claude Code subagent

Squarewright measures itself honestly on real PRs ([`NORTH_STAR.md`](../../NORTH_STAR.md)). The **defect-match
judge** decides, per known ground-truth defect, whether any of a reviewer's findings identifies the *same root
cause and location* — not merely the same file. There are two judge paths; they are complementary.

## The three judges

| path | model | speed | cost | family | use for |
|---|---|---|---|---|---|
| `scripts/judge.ts` | z.ai `glm-5.2` (default) | ~30–40s/call; ~40 min per 3-report set | free (z.ai) | GLM (same-family) | programmatic, CI/cron, offline re-scoring, the `--reports` matrix, `--judge-repeats` — but SAME-family, so it inflates GLM analysis |
| **`scripts/judge-cli.ts`** | a subscription CLI, default `claude -p` (`/claude-headless`) | ~1–2 min per report | free (subscription) | **cross-family** vs GLM/DeepSeek | the headless CROSS-FAMILY path — parses JSON grades from the reply, no custom-tool-calling needed. `--cli`/`--model`/`--effort`/`--repeats` |
| **Claude Code subagent** | Claude (this session) | ~1–4 min per report | free in-session | cross-family vs GLM/deepseek reviewers | **interactive** measurement while an agent is driving; can read files for a deeper grade |

Both Claude-driven judges are free, **don't contend with the dogfood reviewer's shared z.ai quota**, and are
genuinely **cross-family** (no GLM self-preference — the risk that gates #49 AC2).

**Why a CLI/subagent judge and not a paid API judge (2026-07-14):** the cross-family API judges proved UNRELIABLE
at calling the `submit_grades` custom tool thinking-off — free OpenRouter `deepseek-v3.2` dropped it 81/81, and the
flat-fee opencode Go-tier models (`kimi-k2.6` at thinking off AND low, `deepseek-v4-pro`) drop it 9/9 too (an
opencode-endpoint custom-tool issue, not a reasoning one). `judge.ts` gained a `--judge-thinking` override to test
that — it did NOT fix the opencode drop. So the reliable cross-family judges are the two Claude-driven ones above,
which never need a custom tool (they emit grades as text/JSON). `judge.ts` with `zai:glm-5.2` stays the headless
path only when a same-family (inflated) number is acceptable. **Judge numbers are noisy** — they swing ±2–4 by judge
choice AND run-to-run for the same judge (e.g. AC4's report A: subagent 5, `claude -p` 2–3) — so report ranges over
≥3 reports and cross-check with a second judge before recording any absolute recall number.

## The protocol (what to hand a judge subagent)

Give it exactly three things and the strict rule:

1. The **report** (`eval/reports/*.json`) — `results[].findings[]` are the reviewer's findings `{path, line, message}`.
2. The **ground truth** (`eval/golden/manifest.yaml`) — has-issue cases carry `expect_loci[]` = `{path, about, evidence?}`.
3. The **grading contract**, verbatim from `src/eval/judge.ts`'s `SYSTEM` prompt (only the trailing
   `Call submit_grades exactly once` is dropped — a subagent returns the count in prose instead):

   > For each known defect, decide whether ANY of the reviewer's findings correctly identifies the SAME
   > underlying problem — same root cause and location, not merely the same file or a superficial mention. Be
   > strict: a finding that lands on the right file but describes a different issue does NOT match.

Tell it to grade each locus **independently before summing**, be honest about close calls, and skip clean cases.
Note `ci-moby-52727` is relabeled `clean` (its real defect is external) → **11 has-issue loci** across 8 cases.

## Validation (2026-07-09, #61)

Two saved reports, subagent judge vs the z.ai/deepseek judges — agreed on both, graded independently (no anchoring):

| report | subagent judge | `scripts/judge.ts` |
|---|---|---|
| `glm-5.2 …12-17…` | **4**/11 | glm-5.2: 4–5 (median 4) |
| `glm-5.2 …00-47…` | **6**/11 | glm-5.2: 6 · deepseek-v3.2: 6 |

## When they disagree

Judge stochasticity is real (#49 AC1 — the GLM judge re-scores the *identical* report 8 then 7). If the subagent
and GLM judges differ beyond that noise, re-score **both** and report the spread; never silently prefer one.
