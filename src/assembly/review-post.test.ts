import { afterEach, describe, expect, test } from "bun:test";
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

// z.ai analysis lane; the pass-2 structurer defaults to openrouter, so BOTH keys are required.
const ZAI_CONFIG: AssemblyConfig = {
  grounders: [],
  lanes: [{ id: "cheap", model: "glm-5-turbo", provider: "zai" }],
  personas: [{ id: "gen", lane: "cheap", prompt: "x", when: ["always"] }],
};

describe("runReviewPost preflight", () => {
  const NAMES = ["OPENROUTER_API_KEY", "ZAI_API_KEY"];
  const saved = new Map(NAMES.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const [n, v] of saved) {
      if (v === undefined) {
        delete process.env[n];
      } else {
        process.env[n] = v;
      }
    }
  });

  test("fails before constructing the worker when a required key is missing", async () => {
    process.env.ZAI_API_KEY = "z"; // pass-1 provider present
    process.env.OPENROUTER_API_KEY = ""; // pass-2 structurer provider absent
    let made = false;
    const makeWorker = (): PiWorker => {
      made = true;
      return {
        run: () =>
          Promise.resolve({
            findings: [],
            usage: { submitted: true, toolCalls: 0 },
          }),
      };
    };

    await expect(
      runReviewPost(ZAI_CONFIG, CONTEXT, makeWorker)
    ).rejects.toThrow("OPENROUTER_API_KEY");
    // no worker was constructed → worker.run was never reached → no z.ai spend on a doomed run
    expect(made).toBe(false);
  });
});
