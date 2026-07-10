# Rules-bearing measurement fixture

The repeatable answer to *"does a Tier-A `.review-rules` rule actually change a review?"* (ADR-0005 §1;
AGENTS.md Hard Rule #5). The golden corpus can't measure this — its 18 external-repo cases have no
`.review-rules/`, and `scripts/eval.ts` drives the Worker directly, bypassing the `runReview` rule-injection
path. So this fixture drives the **real product path** (`cli.ts review` → `runReview` → `fsRepoReader`).

## Design (why it isolates the rule)

- **Made-up rule** (`rules/clock.md`): "all wall-clock time must come from `src/clock.ts`; never call
  `Date.now()`." A convention the model cannot know from training.
- **Fake repo name** (`artifact/pr-meta.json` → `acme/widget`): avoids the public-repo leakage that confounded
  an earlier probe (the model knew `squarewright`'s real `Poster` convention from training).
- **Otherwise-clean violating diff** (`artifact/`): `Date.now()` is normal code, so without the rule the reviewer
  has no reason to flag it — an OFF-arm hit would be noise, not the rule.
- **`target.json`**: the file/line of the violation + the rule's concept keywords, fed to the deterministic
  `detectRuleFinding` (`src/eval/rules-probe.ts`, unit-tested) so the *detector* adds no stochasticity — the
  reviewer run is the only variable.

## Run

```
RUNS=5 bun run scripts/measure-rules.ts   # needs a z.ai key in $ZAI_API_KEY or ~/.zai_key
```

Reports `ON = x/N · OFF = y/N` (how often the injected violation was flagged). A large ON−OFF gap is the rule
working. Record the range + date in [`eval/RESULTS.md`](../RESULTS.md); never present a single run as a fact.
