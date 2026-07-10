/**
 * Shared Pi agent-session settings — one definition for every `createAgentSession` call (the Worker's two passes
 * and the reply-interpreter), so retry tuning lives in exactly one place.
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";

// retry.provider re-enables the openai-node SDK's own HTTP-level 429/5xx backoff, which Pi zeroes out by
// default (openai-completions.ts sets maxRetries:0). It reacts per-request and honors server-requested delay,
// which is the right layer for z.ai's undocumented concurrency throttle — the agent-level `retry` (fixed
// 2s/4s/8s, whole-turn restart) stays on as a coarse backstop. See docs/design/zai-reliability.md.
export const agentSessionSettings = () =>
  SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: {
      enabled: true,
      maxRetries: 2,
      provider: { maxRetries: 4, maxRetryDelayMs: 20_000 },
    },
  });
