# Contamination-safe corpus

A second eval corpus, built to answer one question the golden corpus **can't**: is the ~2–5/11 recall ceiling we
keep hitting **corpus difficulty**, or **memorization saturation**?

The golden corpus (`eval/golden/`) is real, evidence-backed PRs — but from **famous** repos (tokio, vite, rails,
…) whose reverts are blogged, discussed, and near-certainly in every model's pretraining. So a model that
"catches" a golden defect might be **recalling training data**, not reviewing. That makes the golden set a poor
instrument for ranking models (especially frontier ones, which may have memorized these PRs *harder*).

This corpus holds the **same kind of case** (a real PR that introduced a real defect, backed by a later revert or
a regression-fix PR that names it) but from **obscure/medium repos** (roughly 50–4000 stars — not the mega-famous
ones), so a catch is far more likely to be reasoning than recall. Same manifest schema as `../golden/manifest.yaml`.

Run it with the eval's `--manifest` flag (frozen diffs live in `./diffs/`, a sibling of the manifest):

```
bun run scripts/eval.ts --manifest eval/contam-safe/manifest.yaml --freeze          # fetch + freeze diffs
bun run scripts/eval.ts --manifest eval/contam-safe/manifest.yaml --provider zai --model glm-5.2 --thinking off
```

**How to read it:** if this corpus and the golden corpus produce the **same** model ranking, that's weak evidence
contamination isn't dominating. If models (especially frontier) look **dramatically better on golden than here**,
that's the tell that golden recall is partly memorization — and this set becomes the honest instrument for any
future model rank. Curated to keep every has-issue case **evidence-backed** (a linked revert/regression), same bar
as golden.
