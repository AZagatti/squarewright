# Fast defect judge via a Claude Code subagent

Squarewright measures itself honestly on real PRs ([`NORTH_STAR.md`](../../NORTH_STAR.md)). The **defect-match
judge** decides, per known ground-truth defect, whether any of a reviewer's findings identifies the *same root
cause and location* — not merely the same file. There are two judge paths; they are complementary.

## The two judges

| path | model | speed | cost | family | use for |
|---|---|---|---|---|---|
| `scripts/judge.ts` | z.ai `glm-5.2` (default), or a cheap paid non-GLM (`deepseek-v3.2`) | ~30–40s/call; ~40 min per 3-report set | free (z.ai) / ~$0.01 (deepseek) | GLM (same-family) / DeepSeek (cross) | programmatic, CI/cron, offline re-scoring, the `--reports` matrix, `--judge-repeats` |
| **Claude Code subagent** | Claude (this session) | ~1–4 min per report | free in-session | cross-family vs GLM/deepseek reviewers | **interactive** measurement while an agent is driving |

The subagent judge is dramatically faster, free, **doesn't contend with the dogfood reviewer's shared z.ai
quota**, and is genuinely **cross-family** (no GLM self-preference — the risk that gates #49 AC2). It cannot run
headless (CI/cron have no Claude session), so `scripts/judge.ts` stays the programmatic path.

## The protocol (what to hand a judge subagent)

Give it exactly three things and the strict rule:

1. The **report** (`eval/reports/*.json`) — `results[].findings[]` are the reviewer's findings `{path, line, message}`.
2. The **ground truth** (`eval/golden/manifest.yaml`) — has-issue cases carry `expect_loci[]` = `{path, about, evidence?}`.
3. The **grading contract**, verbatim from `src/eval/judge.ts`'s SYSTEM prompt: *for each known defect, decide
   whether ANY of that case's findings identifies the SAME underlying problem — same root cause AND location,
   not merely the same file or a superficial mention. Be strict.*

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
