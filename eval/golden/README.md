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
```

Reports are written to `eval/reports/<model>-<stamp>.json` for side-by-side comparison.

## Model shortlist to compare (grounded in trimwire's bench)

Cheap models that ranked well for review, best-first. All OpenRouter ids unless noted:

1. `deepseek/deepseek-v3.2` (reasoning off) — broad/fast generalist "thoroughness anchor".
2. `qwen/qwen3-coder-30b-a3b-instruct` (reasoning off) — cheapest; strong when paired with a tight checklist.
3. `openai/gpt-5-mini` (effort medium) — trimwire's security anchor; good calibration baseline.
4. `deepseek/deepseek-v4-flash` — narrow single-persona only; avoid as a large-diff generalist (malforms JSON).
5. `glm-5.2` — **z.ai-only** (provider `zai`, free sub); highest attested recall but no verified OpenRouter path.

Reality check from trimwire's 67-case bench: real ambiguous-PR recall ≈ **27% at ~19% noise** (synthetic
planted-bug recall of 80–100% massively overstates it). Judge the corpus against that, not perfection.

## Scoring notes (v1, deliberately simple)

- Clean false-positives = findings on clean cases (post-verify when `--verify`).
- Locus recall = expected loci whose file a finding lands on (loose basename match).
Precise finding↔ground-truth matching (a judge pass) is a later refinement; v1 favours a cheap, stable signal.
