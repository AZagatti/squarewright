import { describe, expect, test } from "bun:test";
import type { ReviewContext } from "../core/types.js";
import type { PiWorker } from "../pi/session.js";
import type { AssemblyConfig } from "./config.js";
import { runReviewPost } from "./review-post.js";

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

  test("constructs the worker with the resolved keys when none are missing", async () => {
    let received: Record<string, string> | undefined;
    const deps = {
      makeWorker: (apiKeys: Record<string, string>) => {
        received = apiKeys;
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
    expect(out.sticky).toContain("No blocking issues found");
  });
});
