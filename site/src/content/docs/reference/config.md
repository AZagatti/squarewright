---
title: Config — .squarewright.yml
description: The declarative assembly config written by squarewright init.
---

`.squarewright.yml` declares the reviewer assembly. `squarewright init` scaffolds it from the default personas.

```yaml
budget:
  maxToolCalls: 30
cotScaffold: false          # opt-in precision/recall tradeoff (see note)
defaultLane: cheap
feedback: { aggregate: false, enabled: true }
grounders: []               # optional deterministic grounders (off by default)
lanes:
  - { id: strong, model: glm-5.2, provider: zai, thinking: off }
  - { id: cheap,  model: glm-5.2, provider: zai, thinking: off }
personas: [ … ]             # from the default set; edit freely
structurer: { id: structurer, model: glm-5-turbo, provider: zai, thinking: off }
```

Key fields:

- **lanes** — named `(provider, model, thinking)` targets. Point `strong` at a frontier model for deeper review.
- **personas** — review lenses. `acCheck: true` marks the opt-in AC-conformance auditor (runs on a strong lane).
- **cotScaffold** — appends an explain→find→verify step. A precision/recall **tradeoff** (fewer false positives,
  a small recall cost); off by default.
- **structurer** — the fixed pass-2 extractor that turns the analysis prose into structured findings.

The reviewer is model-agnostic: retarget lanes, trim personas, or swap the provider entirely.
