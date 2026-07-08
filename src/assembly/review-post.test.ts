import { describe, expect, test } from "bun:test";
import type { ReviewContext } from "../core/types.js";
import type { Poster } from "../github/poster.js";
import type { PiWorker } from "../pi/session.js";
import type { TrustedRunSignal, VerifiedTarget } from "../safety/trust.js";
import type { AssemblyConfig } from "./config.js";
import type { ReviewOutput } from "./review.js";
import {
  postReviewOutput,
  readTrustedRunSignal,
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

const OUTPUT: ReviewOutput = {
  findings: [],
  inline: [{ body: "b", line: 1, path: "a.ts" }],
  sticky: "STICKY BODY",
  unplaceable: [],
};

const TRUSTED: TrustedRunSignal = { baseRepo: "o/r", headSha: "cafe1234" };

const TARGET: VerifiedTarget = {
  commitSha: "cafe1234",
  prNumber: 1,
  repo: "o/r",
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

describe("postReviewOutput", () => {
  test("verifies the target, then posts the review before the sticky", async () => {
    const order: string[] = [];
    let reviewTarget: VerifiedTarget | undefined;
    const poster: Poster = {
      postReview: (target) => {
        order.push("review");
        reviewTarget = target;
        return Promise.resolve();
      },
      upsertSticky: () => {
        order.push("sticky");
        return Promise.resolve();
      },
    };

    const result = await postReviewOutput(OUTPUT, CONTEXT, TRUSTED, {
      poster,
      verifyTarget: () => Promise.resolve(TARGET),
    });

    expect(result).toEqual(TARGET);
    expect(order).toEqual(["review", "sticky"]);
    expect(reviewTarget).toEqual(TARGET);
  });

  test("posts nothing when the trust check refuses", async () => {
    let posted = false;
    const poster: Poster = {
      postReview: () => {
        posted = true;
        return Promise.resolve();
      },
      upsertSticky: () => {
        posted = true;
        return Promise.resolve();
      },
    };

    await expect(
      postReviewOutput(OUTPUT, CONTEXT, TRUSTED, {
        poster,
        verifyTarget: () => Promise.reject(new Error("TrustViolation: nope")),
      })
    ).rejects.toThrow("TrustViolation");
    expect(posted).toBe(false);
  });
});
