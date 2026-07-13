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

Pi supports ~30 providers plus a custom-provider hook, so "any model, cheap or frontier, hosted or local" is a
config edit, not a rewrite.
