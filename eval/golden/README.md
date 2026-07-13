# Golden PRs — reproducible review-eval corpus

A frozen, version-controlled set of real pull requests across stacks, so we stop re-hunting PRs every time
and can compare models/prompts/verifiers on a **fixed** baseline.

## Layout

- `manifest.yaml` — the case list (metadata + ground-truth labels). Committed.
- `diffs/<id>.diff` — the **frozen** unified diff for each case (via `gh pr diff`, fetched once). Committed —
  this is what makes runs reproducible even if the PR later changes.
- Reports land in `eval/reports/` (gitignored run artifacts).

## Case shape (`manifest.yaml`)

```yaml
cases:
  - id: ts-hono-5067        # unique kebab id; also the diff filename
    repo: honojs/hono
    pr: 5067
    stack: ts               # ts | css | rust | go | python | ruby | ci | config | docker | ...
    kind: bugfix            # bugfix | refactor | feature | perf | test | config | security
    label: clean            # clean | has-issue
    note: "what a good reviewer should conclude, and why (source of truth)"
    evidence: "merged, well-reviewed"     # for has-issue: a link/quote proving the defect
    expect_loci:            # ONLY for has-issue — where the real problem is
      - path: src/utils/body.ts
        about: "one-line description of the issue a reviewer should catch"
```

- **clean** cases measure the **false-positive rate** — a good reviewer should stay quiet (0 real findings).
- **has-issue** cases measure **recall** — a good reviewer should flag `expect_loci`. Ground-truth must be
  evidence-backed (a reviewer comment, a follow-up fix/revert, or a linked issue) — never invented.

## Usage

```bash
# one-time (or when adding cases): fetch + freeze diffs — no model calls, no cost
bun run scripts/eval.ts --freeze

# compare a model over the corpus (add --verify to run the adversarial verifier)
bun run scripts/eval.ts --model deepseek/deepseek-v3.2 --verify
bun run scripts/eval.ts --model qwen/qwen3-coder --stack rust

# scoring: clean → false positives (raw or post-verify); has-issue → locus recall

# --analysis-recall: ALSO score loci against the raw pass-1 analysis PROSE (before the structurer runs), so a
# model rank separates the analysis model's reachability from the structurer's extraction drop (the #78 confound).
# Reports two columns: hits (structured) and ahits (analysis-level), plus a per-locus `drop` (analysis-named ∧
# ¬structured). Use it when a model's low structured recall might be a structurer artifact, not an analysis ceiling.
bun run scripts/eval.ts --model zai/glm-5.2 --analysis-recall
```

**`drop` is an UPPER BOUND, not a point estimate.** The match is FILE-LEVEL: it counts the analysis *naming* the
file, which includes a clean-verdict review ("I found no issues") that merely mentions the file in passing — that
is NOT a structurer drop. Dogfooded on the golden set (2026-07-13), ~1/3 of the reported drops were such
clean-verdict mentions. **Confirm a real drop per-case**: a rich analysis that flags a defect + `raw=0` structured
findings on that file = a true structurer drop; a clean-verdict mention is not. A defect-level judge is the real fix.

**Do NOT infer "a stronger structurer would recover the drop" from a naive structurer A/B** (`--structurer` swap
across two runs): the eval re-runs pass-1 (analysis) every time and analysis is non-deterministic, so two runs'
structured recall differ by analysis variance, not just structurer quality. Settling that needs a **fixed-analysis**
A/B — cache one pass-1 output per case, then re-run only pass-2 across structurers on that frozen prose (not yet built).

Reports are written to `eval/reports/<model>-<stamp>.json` for side-by-side comparison.

## Models — ranking is DEFERRED until the setup is good

We do **not** rank models yet. A ranking now would just measure a half-built harness (one generic persona,
diff-only, no repo grounding). Sequence: **make the setup good against these golden PRs first, then rank.**

**Develop the setup with a strong model** so model quality isn't the confound. The genuinely good reviewers
are the expensive **"5-family" frontier models** (e.g. `anthropic/claude-sonnet-5`, `openai/gpt-5`, Opus-class)
— that's the quality ceiling. Use one of those while iterating the harness.

**Cheap candidates to rank LATER** (the value question — how close do they get with our grounding + verifier).
All OpenRouter; **no z.ai models via OpenRouter** (GLM only via z.ai directly, and it's effectively deprecated
for sustained CI — trial/subscription only):

- `deepseek/deepseek-v3.2` (thinking off / on) — broad/fast generalist.
- `qwen/qwen3.5-flash-02-23` (thinking) — newer, ~$0.003/verified-review even with thinking on, 1M ctx.
- `qwen/qwen3-coder-30b-a3b-instruct` — cheapest; no thinking mode.
- `minimax/minimax-m2.5` — ~80% SWE-Bench Verified at pennies; biggest upside bet.
- `openai/gpt-5-mini` (effort medium) / `openai/gpt-5-nano` (low) — 5-family, cheaper tiers.
- `deepseek/deepseek-v4-flash` — narrow only; malforms JSON on large/aggregation inputs.

Reality check from trimwire's 67-case bench: real ambiguous-PR recall ≈ **27% at ~19% noise** (synthetic
planted-bug recall of 80–100% massively overstates it). Judge against that, not perfection.

## Scoring notes (v1, deliberately simple)

- Clean false-positives = findings on clean cases (post-verify when `--verify`).
- Locus recall = expected loci whose file a finding lands on (loose basename match).
Precise finding↔ground-truth matching (a judge pass) is a later refinement; v1 favours a cheap, stable signal.
