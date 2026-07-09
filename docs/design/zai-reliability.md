# z.ai (GLM) reliability & latency — what we know, what we do

> See also [`../reference/models-reasoning-and-cost.md`](../reference/models-reasoning-and-cost.md) for the broader
> provider reference (reasoning control, caching, batch, OpenRouter, cost/process lessons).

GLM models reach squarewright **only through the z.ai Coding Plan** (subscription, flat cost), never
OpenRouter. That makes them the cheap default for the analysis pass, but the subscription endpoint has an
**undocumented, real concurrency ceiling** (empirically ~5 in-flight requests before 429s) and ~40s/call
latency. This note records what was verified against Pi's source and z.ai's docs, and the levers we pull.

## Verified facts (read from Pi source, not guessed)

1. **Pi disables the SDK's HTTP-level retry by default.** `packages/ai/src/api/openai-completions.ts` sets
   `maxRetries: options?.maxRetries ?? 0` on every request — the openai-node client's built-in 2×
   429/5xx/timeout backoff is off unless `retry.provider.maxRetries` is set in Pi settings
   (`sdk.ts` → `settings-manager.getProviderRetrySettings()`).
2. **Pi's agent-level retry is fixed backoff, not header-aware.** `agent-session.ts` retries a whole failed
   *turn* up to `retry.maxRetries` (default 3) at `baseDelayMs·2^(n-1)` (2s/4s/8s). 429s match the retryable
   regex in `ai/src/utils/retry.ts`, so they *are* retried — just on a schedule that ignores any
   server-provided delay.
3. **`Retry-After` parsing exists only on the Codex Responses path**, not the generic `openai-completions`
   path the z.ai provider uses. So Pi never reads z.ai's 429 backoff header for GLM calls.
4. **No client-side concurrency semaphore exists in Pi** for provider calls. Fire >~5 in-flight GLM calls and
   nothing in Pi stops you before z.ai does.
5. **HTTP/2 is hard-disabled** (`http-dispatcher.ts` `allowH2:false`); keep-alive pooling is on. Not a knob.
6. z.ai model metadata already carries latency levers: `glm-5.2` has a `thinkingLevelMap`
   (`minimal→disabled`, `low/medium/high→"high"`, `xhigh→"max"`); `glm-4.7/5-turbo/5.1/5.2/5v-turbo` set
   `zaiToolStream:true` (streamed tool-call deltas); `glm-4.5-air` does not.

## What squarewright does about it

- **Cap concurrency ≤5 for any z.ai analysis lane.** The eval's `pool(cases, concurrency, …)` is the de-facto
  semaphore: passes within a case run sequentially, so in-flight z.ai requests ≈ `concurrency`. Keep
  `--concurrency ≤5` when the analysis model is GLM. (>5 was confirmed to stall with 429s.)
- **Provider-level retry is on** (`src/pi/worker.ts` `SETTINGS`): `retry.provider = { maxRetries: 4,
  maxRetryDelayMs: 20_000 }`. This re-enables the SDK's per-request 429/5xx backoff (fact #1), reacting
  faster and more precisely than waiting for a whole turn to fail. Agent-level `retry` stays on as a coarse
  backstop.
- **Prefer the fast/free GLM variants for the analysis pass** for cost/latency — but note a **later judged rank
  (2026-07-09) found `glm-5-turbo` has the *worst* recall of every GLM tested** (0–1/12; it's "clean" because it
  barely finds anything). It's the current default only by inertia; capable models (glm-5.2/glm-4.5) scored higher
  on recall (unconfirmed — see [`../reference/models-reasoning-and-cost.md`](../reference/models-reasoning-and-cost.md)
  and `eval/RESULTS.md`). `glm-4.5-air` is the documented low-latency small model.
- **Drop reasoning effort where quality allows.** z.ai's docs say Max→High on GLM-5.2-class "sacrifices only a
  few points … while effectively halving token output." `--thinking off/minimal` maps to disabled/high via
  `thinkingLevelMap` — cheaper and faster. Our operating point is `--thinking off` anyway.

## Hard limits we can't engineer past on this plan

- **No published concurrency/RPM/TPM numbers.** z.ai's usage-policy gives only relative tier ordering
  (Max>Pro>Lite) and says limits are "dynamically adjusted." Our ~5 is an empirical snapshot, not an SLA —
  one external report saw GLM-4.7 concurrency drop to 1 on Pro tier. There is no API to query the current cap.
- **No documented `Retry-After` contract.** Body codes exist (1302 rate limit, 1305 overloaded) but no header
  contract to program against — client-side backoff + our own concurrency cap is the only supported strategy.
- **Quota is a hard wall.** Lite/Pro/Max cap ~80/400/1600 prompts per 5-hour window (each "prompt" ≈ 15–20
  model invocations). Saturate it and the only fixes are a higher tier or the paid/OpenRouter path (ruled out
  for GLM). The **peak window 14:00–18:00 UTC+8 costs 2–3× quota** — batch evals off-peak.
- **Alternate endpoints don't help.** `/api/anthropic` is just a schema shim (same backend/quota, unverified
  but best evidence); `/api/paas/v4` is pay-as-you-go (leaves the subscription); `open.bigmodel.cn` is a
  separate CN account. None is a free concurrency/latency escape hatch.

Sources: local reads of Pi `packages/ai/src/api/{openai-completions,openai-codex-responses}.ts`,
`packages/ai/src/utils/retry.ts`, `packages/coding-agent/src/core/{settings-manager,sdk,agent-session,http-dispatcher}.ts`,
`packages/ai/src/providers/zai{.ts,.models.ts}`; z.ai devpack overview / usage-policy / api-code docs;
GitHub anomalyco/opencode#8618 (concurrency-cap report); openai-node README (retry defaults).
