# Models, reasoning & cost — provider reference (learned 2026-07-08/09)

Hard-won operational knowledge about the providers we run models on (z.ai, OpenRouter) and Pi's model catalog.
Written after a long measurement session that produced the model rank in [`eval/RESULTS.md`](../../eval/RESULTS.md)
("Model rank + reasoning + self-consistency + structurer") — and cost ~$8 of OpenRouter overspend learning some of it.
Read this before running paid-provider evals or touching reasoning/structurer config.

## TL;DR decisions this produced
- **Default analysis model:** glm-5-turbo is the *worst* reviewer we measured (1/12 defect recall). Use a capable model
  reasoning-**off**: glm-5.2 / glm-4.5 / deepseek-v3.2 all hit 6/12. (Dogfood default change is a tracked follow-up.)
- **Reasoning:** on for *weak* models only. It hurts capable ones (glm-5.2, deepseek both drop with reasoning on).
- **Default structurer:** free `zai/glm-5-turbo` (was paid `openrouter/qwen3-coder-30b` — a per-pass cost footgun).

## z.ai (Zhipu / BigModel — the GLM family)

**Reasoning control is binary, except glm-5.2.**
- z.ai's thinking API is `thinking: {type: "enabled" | "disabled"}` (in `extra_body`). No graduated levels for most models.
- Thinking is **ON by default** for glm-5.2 / glm-5.1 / glm-5 / glm-4.7; glm-4.6 is "default hybrid"; glm-4.5 supports interleaved.
- Only **glm-5.2** exposes effort levels (`reasoning_effort`): pi `low/medium/high` → z.ai `high`; pi `xhigh` → `max`. Others ignore effort (binary).
- **Pi correctly disables it:** `--thinking off` makes Pi send `{type: "disabled"}` (openai-completions.js, `thinkingFormat: "zai"`), which **overrides** the model's default-on. So our reasoning-off runs are genuinely reasoning-off. Verified via code + latency.
- Docs: <https://docs.z.ai/guides/capabilities/thinking-mode>

**Rate limits are per-account, not per-IP.**
- Scoped to the **account/caller**, not IP — so IP rotation/masking does nothing *and* is a ToS violation (key ban). Don't.
- Concurrency is **per-model** on the *metered* pay-as-you-go API (`api.z.ai/api/paas/v4`), but a **single shared pool** on the **Coding Plan subscription** — and Pi's catalog points GLMs at the coding endpoint (`api.z.ai/api/coding/paas/v4`), so **we're on the shared pool**. Spreading load across models does NOT multiply our throughput. Empirical ceiling ~5 concurrent (see [`../design/zai-reliability.md`](../design/zai-reliability.md)).
- 429s carry **no `Retry-After` header** — throttle is signalled by JSON body error codes (1302 rate-limit, 1305 overloaded, 1308/1310 quota with a reset time in the message). Back off by parsing the body. Docs: <https://docs.z.ai/api-reference/api-code>, <https://docs.bigmodel.cn/cn/api/rate-limit>
- **Prompt/context caching is automatic** (no param) — a stable byte-identical prefix (persona system prompt) gets ~80% cheaper cached input; hits show in `usage.prompt_tokens_details.cached_tokens`. Docs: <https://docs.z.ai/guides/capabilities/cache>
- **Batch API is mainland-only** (`open.bigmodel.cn`, 50% off, separate pool) — NOT exposed on international `api.z.ai`. Don't assume it.

## OpenRouter

- **Reasoning:** `reasoning: {effort: "minimal".."high".."max"}` (graduated) **or** `reasoning: {max_tokens: N}` (budget). Discover per-model via `/api/v1/models` → `reasoning.supported_efforts`, `default_effort`, `supports_max_tokens`, `mandatory`. Docs: <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
- **Reasoning tokens ARE output tokens** — billed at the output rate. This is why reasoning-on runs get expensive fast.
- **`max_tokens` caps output (incl. reasoning) at the source** — the reliable cost bound. Pi sends it from the model's catalog `maxTokens`; the default is often huge (131072!). Cap it via a models.json `modelOverride` for cheap tests. (Too *low* a cap can truncate reasoning mid-thought → malformed response → retry loop → billing with no completion; ~32k is a safe "practically off but bounded" value for deepseek.)
- **Adaptive concurrency (AIMD)** is the right client pattern for unknown ceilings: ramp on success, halve on backpressure, honor `Retry-After` as a floor. z.ai has no such header → map its JSON codes (1302/1305 → backoff; 1308+ → hard pause until reset; 1113 balance → fatal). Ref: Netflix/concurrency-limits `AIMDLimit`.
- The management key (`/tmp/openrouter_mgm_key`) can hit `/api/v1/activity` (per-model spend) and `/api/v1/credits`; a normal key cannot fetch activity.

## Pi model catalog (adding / overriding models)

- Custom models & overrides live in **`~/.pi/agent/models.json`** (`getAgentDir()/models.json`), reloaded each run.
- Format: `{"providers": {"<provider>": {"models": [...], "modelOverrides": {...}}}}`. A **new model id under a built-in provider is added alongside** the built-ins (used to add glm-5/4.6/4.5); `modelOverrides.<id>` tweaks a built-in (used to cap deepseek `maxTokens`). Only `id` is required; `baseUrl`/`api`/`compat` allowed at model level. Docs: `node_modules/@earendil-works/pi-coding-agent/docs/models.md`
- `thinkingLevelMap` maps pi thinking levels → provider values (`null` = unsupported/clamped). `compat.supportsReasoningEffort` gates whether `reasoning_effort` is sent (only glm-5.2 has it true).
- Pi's built-in z.ai catalog is auto-generated — **don't fully trust its `thinkingLevelMap`; verify against z.ai docs** (it was accurate for glm-5.2, but the model list lagged real availability).

## Cost & process lessons (paid for in real dollars)

1. **The eval spend guard undercounts reasoning tokens.** `worker.ts` `sumTokens` sums `usage.output`, which excludes reasoning tokens on OR reasoning models → the guard estimated ~$0.5 while actual was ~$3.4 (6.5×). **The reliable cost control is `max_tokens` at the source, not the token-estimate guard.** (Fixing `sumTokens` to count reasoning tokens is a tracked follow-up.)
2. **Don't over-parallelize a rate-limited provider.** 5 configs × conc 5 = 25 concurrent + reasoning models = throttle-retries that inflate BOTH cost and wall-time (retries re-send context and re-bill). Match concurrency to the real ceiling.
3. **The default structurer runs on every pass** — a paid default silently dominated cost (~$3 on structuring in one sweep). Keep it free.
4. **Verify process kills by PID.** `pkill -f` silently failed to match here, so a "killed" run kept spending. Confirm with `ps -eo pid,args` and `kill <pid>`.
5. **Re-check live progress before killing a run** — acting on a stale status reading, a run 12/18-done was killed to "speed it up," which was net slower.
6. **The OR account is shared** — the credits balance can't isolate *our* spend; use per-request `max_tokens` bounds + the mgm-key `/activity` per-model view, not balance deltas.

## Useful links
- z.ai thinking mode: <https://docs.z.ai/guides/capabilities/thinking-mode>
- z.ai error codes (429 JSON codes, no headers): <https://docs.z.ai/api-reference/api-code>
- z.ai rate limits (per-account/model scoping): <https://docs.bigmodel.cn/cn/api/rate-limit>
- z.ai context caching: <https://docs.z.ai/guides/capabilities/cache>
- z.ai batch (mainland): <https://docs.bigmodel.cn/cn/guide/tools/batch>
- OpenRouter reasoning tokens: <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
- Pi custom models: `node_modules/@earendil-works/pi-coding-agent/docs/models.md`
- Netflix concurrency-limits (AIMD reference): <https://github.com/Netflix/concurrency-limits>
- cc-dcp reviewer ideas (scouted): [`../research/cc-dcp-reviewer-ideas.md`](../research/cc-dcp-reviewer-ideas.md)
