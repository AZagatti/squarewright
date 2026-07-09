---
description: Squarewright architecture + trust-boundary conventions
globs: ["src/**"]
---

- **Trust boundary is sacred.** Code in the `gather` path must not receive secrets or execute PR-head code;
  the `review` path is the only trusted zone. Flag any change that lets PR-derived data cross into `gather`
  with secrets, or that blurs the two.
- **Grounders / Verifiers / Policies never call an LLM.** They produce facts or run real tools (compile,
  test, grep). A "verifier" that re-reads text with a model is not a verifier — flag it.
- **GLM only via z.ai, never OpenRouter.** Any paid (OpenRouter) model call must go through the shared spend
  guard and requires an explicit cap. Flag a raw paid call, a model loop, or a missing cap.
- **All GitHub writes go through the `Poster` interface.** Flag a raw `gh`/HTTP GitHub write scattered outside
  `src/github/`.
- **Strict TypeScript.** Do not weaken `tsconfig` (no new `any`, no `@ts-ignore` to silence a real type error).
