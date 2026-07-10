import { describe, expect, test } from "bun:test";
import type { Poster } from "../github/poster.js";
import type { ReplyInterpreter, RuleSuggestion } from "../rules/teach-reply.js";
import { runTeachCommand } from "./teach-post.js";

const RULE: RuleSuggestion = {
  confidence: 0.9,
  ruleText: "Validate req.body before db writes.",
  scope: "API handlers",
};

/** Env for an authorized maintainer teaching a real rule via a PR comment. */
const authedEnv = (): NodeJS.ProcessEnv => ({
  TEACH_ACTOR: "maintainer",
  TEACH_ASSOCIATION: "MEMBER",
  TEACH_BODY: "@squarewright remember: validate req.body",
  TEACH_ISSUE: "7",
  TEACH_PERMISSION: "write",
  TEACH_PR_AUTHOR: "contributor",
  TEACH_REPO: "o/r",
});

function stubInterpreter(returns: RuleSuggestion | null): ReplyInterpreter {
  return { interpret: () => Promise.resolve(returns) };
}

function stubPoster(): Poster & {
  comments: { body: string; prNumber: number; repo: string }[];
} {
  const comments: { body: string; prNumber: number; repo: string }[] = [];
  return {
    comments,
    postComment: (target, body) => {
      comments.push({ body, prNumber: target.prNumber, repo: target.repo });
      return Promise.resolve();
    },
    postReview: () => Promise.resolve(),
    upsertSticky: () => Promise.resolve(),
  };
}

describe("runTeachCommand", () => {
  test("authorized reply with a confident rule posts a suggestion to the PR", async () => {
    const poster = stubPoster();
    const res = await runTeachCommand({
      env: authedEnv(),
      interpreter: stubInterpreter(RULE),
      poster,
    });
    expect(res.outcome.kind).toBe("post");
    expect(res.posted).toEqual({ issueNumber: 7, repo: "o/r" });
    expect(poster.comments).toHaveLength(1);
    expect(poster.comments[0]?.body).toContain("Validate req.body");
    expect(poster.comments[0]?.prNumber).toBe(7);
  });

  test("an unauthorized actor never posts and never calls the model", async () => {
    const poster = stubPoster();
    let interpreterCalls = 0;
    const res = await runTeachCommand({
      env: { ...authedEnv(), TEACH_PERMISSION: "read" },
      interpreter: {
        interpret: () => {
          interpreterCalls += 1;
          return Promise.resolve(RULE);
        },
      },
      poster,
    });
    expect(res.outcome).toEqual({ kind: "skip", reason: "unauthorized" });
    expect(poster.comments).toHaveLength(0);
    expect(interpreterCalls).toBe(0);
  });

  test("a non-trigger reply skips without posting", async () => {
    const poster = stubPoster();
    const res = await runTeachCommand({
      env: { ...authedEnv(), TEACH_BODY: "thanks, nice review" },
      interpreter: stubInterpreter(RULE),
      poster,
    });
    expect(res.outcome).toEqual({ kind: "skip", reason: "no-trigger" });
    expect(poster.comments).toHaveLength(0);
  });

  test("a low-confidence interpretation posts nothing", async () => {
    const poster = stubPoster();
    const res = await runTeachCommand({
      env: authedEnv(),
      interpreter: stubInterpreter({ ...RULE, confidence: 0.1 }),
      poster,
    });
    expect(res.outcome).toEqual({ kind: "skip", reason: "no-durable-rule" });
    expect(poster.comments).toHaveLength(0);
  });

  test("fails closed when a required trusted signal is missing", () => {
    for (const key of ["TEACH_REPO", "TEACH_ISSUE", "TEACH_BODY"] as const) {
      const env = authedEnv();
      delete env[key];
      expect(
        runTeachCommand({
          env,
          interpreter: stubInterpreter(RULE),
          poster: stubPoster(),
        })
      ).rejects.toThrow(key);
    }
  });

  test("fails closed on a non-numeric issue number", () => {
    expect(
      runTeachCommand({
        env: { ...authedEnv(), TEACH_ISSUE: "not-a-number" },
        interpreter: stubInterpreter(RULE),
        poster: stubPoster(),
      })
    ).rejects.toThrow("TEACH_ISSUE");
  });

  test("does not fetch the finding for an unauthorized actor", async () => {
    let fetched = 0;
    const res = await runTeachCommand({
      env: { ...authedEnv(), TEACH_PERMISSION: "read" },
      fetchFinding: () => {
        fetched += 1;
        return Promise.resolve("finding");
      },
      interpreter: stubInterpreter(RULE),
      poster: stubPoster(),
    });
    expect(res.outcome).toEqual({ kind: "skip", reason: "unauthorized" });
    expect(fetched).toBe(0);
  });

  test("uses fetchFinding for the grounding text when provided", async () => {
    const poster = stubPoster();
    let received: string | undefined;
    await runTeachCommand({
      env: authedEnv(),
      fetchFinding: () => Promise.resolve("the finding it replied to"),
      interpreter: {
        interpret: (input) => {
          received = input.findingText;
          return Promise.resolve(RULE);
        },
      },
      poster,
    });
    expect(received).toBe("the finding it replied to");
  });
});
