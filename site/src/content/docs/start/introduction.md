---
title: What Squarewright is
description: An open-source toolbox for assembling a repo-local AI code reviewer you own, on any model.
---

Squarewright is the **assembly layer** that turns a language model into a trustworthy pull-request reviewer that
lives in *your* repository and that you fully own. It is **not** a hosted SaaS, not "a free CodeRabbit", and not a
deterministic static analyzer.

It owns the parts you'd otherwise hand-roll — and get subtly, dangerously wrong:

- the **two-phase CI workflow** with a real trust boundary between secrets and untrusted fork code;
- an artifact **head-SHA cross-check** so a poisoned diff can't redirect where a comment lands;
- **personas** + routing, a **rules** memory, model-lane **policy**;
- careful **posting**: a sticky summary + inline comments, deduped, hardened against markdown injection.

The model is the reviewer — you choose it (any of Pi's ~30 providers, free/frontier/hosted/local) and swap it by
editing a lane. Deterministic **grounders** and **verifiers** only ever feed or check the model; they're never the
product.

:::caution[Status: pre-v0.1]
The review engine is real and dogfooded on this project's own PRs, but a published CLI you can `init`-and-go is not
ready — today you assemble Squarewright **from source**. See [Install & first review](/start/quickstart/).
:::

Squarewright is **honest about how good it is**: it measures itself on real PRs and reports recall and precision
separately, refusing a single flattering blended number. Recall on the free default model is low and model-bound —
which is exactly why the model lane is yours to raise. See the public
[eval record](https://github.com/AZagatti/squarewright/blob/main/eval/RESULTS.md).
