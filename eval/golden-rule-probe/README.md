# Golden-PR rules probe

The realistic companion to `eval/rules-fixture/` (which uses a made-up rule): does a project rule help catch a
**real, documented** defect? See the write-up in [`eval/RESULTS.md`](../RESULTS.md) ("Golden-PR rules probe").

## Case

`ts-vite-21019` — a `copyDir` → `fs.cpSync` refactor vite later reverted (omits `dereference: true`, so symlinks
stop being followed; also a Windows non-ASCII `fs.cpSync` bug). Ground truth is in `eval/golden/manifest.yaml`.

## Design — 4 arms, same convention content, different delivery

- **Baseline**: nothing.
- **Tier-A**: the convention as a `.review-rules` precedence rule (`rules/copy.md`).
- **Tier-B**: the *same* convention as a background doc (`docs/CONVENTIONS.md`) via `contextDocs`.
- **A+B**: both.

The rule/doc is an **invented-but-plausible** project convention ("use `copyDir`, never `fs.cpSync`") — vite
doesn't actually mandate it; it's chosen so the *delivery mechanism* is the only variable.

## Reproduce

```
# 1. build the artifact from the committed golden diff
bun run scripts/diff-to-artifact.ts ts-vite-21019 eval/golden-rule-probe/artifact "acme/vite-fork" "cpSync refactor"
# 2. run each arm N times through the product path (cli review), pointing -C at an arm dir that has
#    .squarewright.yml (+ .review-rules/copy.md for A, + contextDocs→CONVENTIONS.md for B, both for A+B)
# 3. grade each saved output with a defect-match judge (see docs/reference/subagent-judge.md)
```

`runs/` holds the 12 graded outputs (3/arm) from the recorded run, committed for audit. Re-running produces
fresh (stochastic) outputs — record the range, never a single count.
