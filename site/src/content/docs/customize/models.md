---
title: Models & lanes
description: Point the reviewer at any model; raise the quality ceiling by choosing a stronger one.
---

The default lanes run on z.ai's free `glm-5.2` (reasoning-off), with the free `glm-5-turbo` as the pass-2
structurer. Set `ZAI_API_KEY` and you have a working reviewer at $0.

```yaml
lanes:
  - { id: strong, model: glm-5.2, provider: zai, thinking: off }
  - { id: cheap,  model: glm-5.2, provider: zai, thinking: off }
```

**Raise the ceiling by pointing a lane at a stronger model.** Recall on the free default is model-bound; a stronger
reasoning model measurably lifts it. In the project's own eval, a strong reasoning model roughly **doubled** defect
recall over the free default (with better precision) — the honest tradeoff is latency and a paid/quota dependency.
The default stays free; the strong lane is yours to raise.

```yaml
lanes:
  - { id: strong, model: <a-frontier-or-reasoning-model>, provider: <openrouter|anthropic|…> }
```

**Spend on the analysis model, not the structurer.** A review runs in two passes: the *analysis* model (your lane)
reasons over the change and writes its findings as prose, then a fixed, cheap *structurer* extracts them into
structured output. The project's eval shows recall is bound by the **analysis** pass — swapping the structurer for a
stronger model changed recall by nothing (it extracts exactly what the analysis already found). So put your model
budget on the lane; leave the free `glm-5-turbo` structurer alone unless you're on a non-z.ai provider (then point
`structurer` at one of its cheap models).

Pi supports ~30 providers plus a custom-provider hook, so "any model, cheap or frontier, hosted or local" is a
config edit, not a rewrite.
