import { describe, expect, test } from "bun:test";
import type { ModelLane, ReviewContext } from "../core/types.js";
import type { Poster } from "../github/poster.js";
import type { PiWorker, RepoReader, WorkerRequest } from "../pi/session.js";
import type { LookupPullsForCommit, VerifiedTarget } from "../safety/trust.js";
import type { AssemblyConfig } from "./config.js";
import type { ReviewOutput } from "./review.js";
import {
  assertNoReasoningTrap,
  readTrustedRunSignal,
  requiredProviders,
  runReviewCommand,
  runReviewPost,
} from "./review-post.js";

const CONTEXT: ReviewContext = {
  baseSha: "",
  body: "",
  files: [],
  headSha: "",
  prNumber: 1,
  repo: "o/r",
  title: "t",
};

const CONFIG: AssemblyConfig = {
  grounders: [],
  lanes: [{ id: "cheap", model: "glm-5-turbo", provider: "zai" }],
  personas: [{ id: "gen", lane: "cheap", prompt: "x", when: ["always"] }],
};

const STUB_WORKER: PiWorker = {
  run: () =>
    Promise.resolve({ findings: [], usage: { submitted: true, toolCalls: 0 } }),
};

describe("assertNoReasoningTrap (issue #36)", () => {
  const orConfig = (structurerModel?: string): AssemblyConfig => ({
    grounders: [],
    lanes: [
      { id: "strong", model: "vendor/trap-model", provider: "openrouter" },
    ],
    personas: [{ id: "gen", lane: "strong", prompt: "x", when: ["always"] }],
    structurer: structurerModel
      ? { model: structurerModel, provider: "openrouter", thinking: "off" }
      : undefined,
  });

  test("refuses a reasoning-trap OpenRouter analysis lane", () => {
    expect(() =>
      assertNoReasoningTrap(orConfig(), (model) => ({
        block: model === "vendor/trap-model",
        detail: "reasoning.mandatory=true",
      }))
    ).toThrow("reasoning cost-trap");
  });

  test("allows an OpenRouter lane whose reasoning disables cleanly", () => {
    expect(() =>
      assertNoReasoningTrap(orConfig(), () => ({
        block: false,
        detail: "safe",
      }))
    ).not.toThrow();
  });

  test("also refuses a reasoning-trap OpenRouter structurer", () => {
    expect(() =>
      assertNoReasoningTrap(orConfig("vendor/trap-structurer"), (model) => ({
        block: model === "vendor/trap-structurer",
        detail: "only supports [high, xhigh]",
      }))
    ).toThrow("vendor/trap-structurer");
  });

  test("never checks non-OpenRouter (z.ai) lanes", () => {
    const checked: string[] = [];
    assertNoReasoningTrap(CONFIG, (model) => {
      checked.push(model);
      return { block: true, detail: "would trap" };
    });
    expect(checked).toEqual([]); // CONFIG is z.ai-only → classifier never invoked, so no false refusal
  });

  test("is a no-op when no classifier is injected", () => {
    expect(() => assertNoReasoningTrap(CONFIG)).not.toThrow();
  });

  test("runReviewPost refuses a trap lane before constructing the worker", async () => {
    let made = false;
    await expect(
      runReviewPost(orConfig(), CONTEXT, {
        makeWorker: () => {
          made = true;
          return STUB_WORKER;
        },
        reasoningRisk: () => ({
          block: true,
          detail: "reasoning.mandatory=true",
        }),
        resolveKeys: () =>
          Promise.resolve({ apiKeys: { openrouter: "or" }, missing: [] }),
      })
    ).rejects.toThrow("reasoning cost-trap");
    expect(made).toBe(false); // refused before any worker/model call
  });
});

describe("runReviewPost preflight", () => {
  test("fails before constructing the worker when a required key is missing", async () => {
    let made = false;
    const deps = {
      makeWorker: () => {
        made = true;
        return STUB_WORKER;
      },
      resolveKeys: () =>
        Promise.resolve({ apiKeys: {}, missing: ["OPENROUTER_API_KEY"] }),
    };

    await expect(runReviewPost(CONFIG, CONTEXT, deps)).rejects.toThrow(
      "OPENROUTER_API_KEY"
    );
    // no worker constructed → worker.run never reached → no spend on a doomed run
    expect(made).toBe(false);
  });

  test("constructs the worker with the resolved keys, forwarding no structurer when unset", async () => {
    let received: Record<string, string> | undefined;
    let receivedStructurer: ModelLane | undefined;
    const deps = {
      makeWorker: (apiKeys: Record<string, string>, structurer?: ModelLane) => {
        received = apiKeys;
        receivedStructurer = structurer;
        return STUB_WORKER;
      },
      resolveKeys: () =>
        Promise.resolve({
          apiKeys: { openrouter: "or", zai: "z" },
          missing: [],
        }),
    };

    const out = await runReviewPost(CONFIG, CONTEXT, deps);

    expect(received).toEqual({ openrouter: "or", zai: "z" });
    // CONFIG sets no structurer, so undefined is forwarded (worker falls back to its default) — not substituted
    expect(receivedStructurer).toBeUndefined();
    expect(out.sticky).toContain("No issues flagged by");
  });

  test("forwards the config's structurer lane to the worker", async () => {
    const structurer: ModelLane = {
      id: "struct",
      model: "glm-5-turbo",
      provider: "zai",
    };
    let receivedStructurer: ModelLane | undefined;
    const deps = {
      makeWorker: (_apiKeys: Record<string, string>, lane?: ModelLane) => {
        receivedStructurer = lane;
        return STUB_WORKER;
      },
      resolveKeys: () =>
        Promise.resolve({ apiKeys: { zai: "z" }, missing: [] }),
    };

    await runReviewPost({ ...CONFIG, structurer }, CONTEXT, deps);

    expect(receivedStructurer).toEqual(structurer);
  });
});

describe("runReviewPost rules loading", () => {
  test("loads Tier-A rules from the repoReader into the prompt, but never forwards it to the worker", async () => {
    let received: WorkerRequest | undefined;
    const spyWorker: PiWorker = {
      run: (req) => {
        received = req;
        return Promise.resolve({
          findings: [],
          usage: { submitted: true, toolCalls: 0 },
        });
      },
    };
    // A no-globs rule always applies, so it injects regardless of the (empty) changed-file set.
    const repoReader: RepoReader = {
      listDir: (p) =>
        Promise.resolve(p === ".review-rules" ? ["- always.md"] : null),
      readFile: (p) =>
        Promise.resolve(
          p === ".review-rules/always.md" ? "ALWAYS RULE BODY" : null
        ),
    };
    const deps = {
      makeWorker: () => spyWorker,
      repoReader,
      resolveKeys: () =>
        Promise.resolve({ apiKeys: { zai: "z" }, missing: [] }),
    };

    await runReviewPost(CONFIG, CONTEXT, deps);

    // rule text reached the prompt...
    expect(received?.systemPrompt).toContain("ALWAYS RULE BODY");
    // ...but the reader did NOT reach the Worker — grounding tools stay off (a separate, off-by-default feature)
    expect(received?.repoReader).toBeUndefined();
  });
});

describe("requiredProviders", () => {
  test("the default structurer is free z.ai — a z.ai-only config forces no other provider", () => {
    // CONFIG's only lane is zai, and the default structurer is now zai too (no forced openrouter)
    expect([...requiredProviders(CONFIG)]).toEqual(["zai"]);
  });

  test("follows a config-specified structurer — no forced openrouter", () => {
    const config: AssemblyConfig = {
      ...CONFIG,
      structurer: { id: "struct", model: "glm-5-turbo", provider: "zai" },
    };
    expect([...requiredProviders(config)]).toEqual(["zai"]);
  });
});

const OUTPUT: ReviewOutput = {
  findings: [],
  inline: [{ body: "b", line: 1, path: "a.ts" }],
  sticky: "STICKY BODY",
  unplaceable: [],
};

const TARGET: VerifiedTarget = {
  commitSha: "cafe1234",
  prNumber: 1,
  repo: "o/r",
};

/** A gather context whose claims agree with the trusted signals below, so the real trust check passes. */
const POST_CONTEXT: ReviewContext = {
  baseSha: "",
  body: "",
  files: [],
  headSha: "cafe1234",
  prNumber: 1,
  repo: "o/r",
  title: "t",
};

describe("readTrustedRunSignal", () => {
  test("returns the signal when both env vars are present", () => {
    expect(
      readTrustedRunSignal({ EVENT_HEAD_SHA: "cafe1234", EVENT_REPO: "o/r" })
    ).toEqual({ baseRepo: "o/r", headSha: "cafe1234" });
  });

  test("throws (fail closed) when a signal is missing", () => {
    expect(() => readTrustedRunSignal({ EVENT_HEAD_SHA: "cafe1234" })).toThrow(
      "EVENT_REPO"
    );
  });
});

interface Seen {
  order: string[];
  postReviewTarget?: VerifiedTarget;
  reviewCalls: number;
  stickyTarget?: VerifiedTarget;
}

/**
 * Build `runReviewCommand` deps that record the order of effects into `seen`. `review` (the paid model run) and
 * `lookup`/`poster` (posting) push labels, so a test can prove the trust check precedes the spend and posting.
 */
function harness(overrides: {
  env?: NodeJS.ProcessEnv;
  lookup?: LookupPullsForCommit;
  postReviewError?: Error;
}): { deps: Parameters<typeof runReviewCommand>[1]; seen: Seen } {
  const seen: Seen = { order: [], reviewCalls: 0 };
  const poster: Poster = {
    postReview: (target) => {
      seen.order.push("postReview");
      seen.postReviewTarget = target;
      return overrides.postReviewError
        ? Promise.reject(overrides.postReviewError)
        : Promise.resolve();
    },
    upsertSticky: (target) => {
      seen.order.push("upsertSticky");
      seen.stickyTarget = target;
      return Promise.resolve();
    },
  };
  const deps = {
    env: overrides.env ?? { EVENT_HEAD_SHA: "cafe1234", EVENT_REPO: "o/r" },
    loadConfig: () => CONFIG,
    lookup:
      overrides.lookup ??
      (() => {
        seen.order.push("lookup");
        return Promise.resolve([{ number: 1 }]);
      }),
    poster,
    readArtifact: () => POST_CONTEXT,
    review: () => {
      seen.order.push("review");
      seen.reviewCalls += 1;
      return Promise.resolve(OUTPUT);
    },
  };
  return { deps, seen };
}

const OPTS = { cwd: ".", input: "artifacts" };

describe("runReviewCommand", () => {
  test("dry run (no --post): prints JSON, never touches the lookup or poster", async () => {
    const { deps, seen } = harness({});

    const result = await runReviewCommand({ ...OPTS, post: false }, deps);

    expect(result.json).toContain("STICKY BODY");
    expect(result.posted).toBeUndefined();
    expect(seen.order).toEqual(["review"]);
  });

  test("--post: verifies before the model runs, then posts review before sticky", async () => {
    const { deps, seen } = harness({});

    const result = await runReviewCommand({ ...OPTS, post: true }, deps);

    expect(result.posted).toEqual(TARGET);
    expect(seen.order).toEqual([
      "lookup",
      "review",
      "postReview",
      "upsertSticky",
    ]);
    expect(seen.postReviewTarget).toEqual(TARGET);
    expect(seen.stickyTarget).toEqual(TARGET);
  });

  test("--post with missing env signals fails closed BEFORE the model runs (no spend)", async () => {
    const { deps, seen } = harness({ env: { EVENT_HEAD_SHA: "cafe1234" } });

    await expect(
      runReviewCommand({ ...OPTS, post: true }, deps)
    ).rejects.toThrow("EVENT_REPO");
    expect(seen.reviewCalls).toBe(0);
  });

  test("--post with an untrusted target fails closed before the model runs, posting nothing", async () => {
    const { deps, seen } = harness({ lookup: () => Promise.resolve([]) });

    await expect(
      runReviewCommand({ ...OPTS, post: true }, deps)
    ).rejects.toThrow("found 0");
    expect(seen.reviewCalls).toBe(0);
    expect(seen.order).toEqual([]);
  });

  test("a failed inline review skips the sticky (no half result)", async () => {
    const { deps, seen } = harness({
      postReviewError: new Error("422 bad line"),
    });

    await expect(
      runReviewCommand({ ...OPTS, post: true }, deps)
    ).rejects.toThrow("422");
    expect(seen.order).toEqual(["lookup", "review", "postReview"]);
  });
});
