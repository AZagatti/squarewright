import { describe, expect, test } from "bun:test";
import { INLINE_MARKER } from "../output/render.js";
import type { VerifiedTarget } from "../safety/trust.js";
import {
  createGhPoster,
  createGhPullLookup,
  type GhRunner,
  spawnRunner,
} from "./poster.js";

const TARGET: VerifiedTarget = {
  commitSha: "cafe1234",
  prNumber: 7,
  repo: "o/r",
};

const STICKY = "<!-- squarewright:review -->\n\n## Squarewright review";

interface Reply {
  code?: number;
  stderr?: string;
  stdout?: string;
}

/** A fake `gh` runner: records every call, and replies via the given responder. */
function fakeRunner(responder: (args: string[], input?: string) => Reply): {
  run: GhRunner;
  calls: { args: string[]; input?: string }[];
} {
  const calls: { args: string[]; input?: string }[] = [];
  const run: GhRunner = (args, input) => {
    calls.push({ args, input });
    const r = responder(args);
    return Promise.resolve({
      code: r.code ?? 0,
      stderr: r.stderr ?? "",
      stdout: r.stdout ?? "",
    });
  };
  return { calls, run };
}

const isWrite = (args: string[]) => args.includes("--method");
const isInlineList = (args: string[]) =>
  args.includes("repos/o/r/pulls/7/comments") && args.includes("--paginate");
const marked = (body: string) => `${INLINE_MARKER}\n\n${body}`;
// a human "Quote reply" prefixes every quoted line with "> ", including our hidden marker
const quotedReply = (quoted: string, reply: string) =>
  `> ${INLINE_MARKER}\n> \n> ${quoted}\n\n${reply}`;

describe("createGhPoster.postReview", () => {
  test("clears prior inline comments (none), then posts one review", async () => {
    const { run, calls } = fakeRunner((args) =>
      isInlineList(args) ? { stdout: "[]" } : { stdout: "{}" }
    );

    await createGhPoster(run).postReview(TARGET, [
      { body: marked("b1"), line: 10, path: "a.ts" },
      { body: marked("b2"), line: 20, path: "b.ts" },
    ]);

    // first lists our prior inline comments (clear), then posts the fresh review
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      "api",
      "repos/o/r/pulls/7/comments",
      "--paginate",
    ]);
    expect(calls[1]?.args).toEqual([
      "api",
      "repos/o/r/pulls/7/reviews",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    const payload = JSON.parse(calls[1]?.input ?? "{}");
    expect(payload.event).toBe("COMMENT");
    expect(payload.commit_id).toBe("cafe1234");
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments[0]).toMatchObject({
      line: 10,
      path: "a.ts",
      side: "RIGHT",
    });
  });

  test("deletes only our prior inline comments — leaves plain and quote-reply human comments — then posts", async () => {
    const prior = JSON.stringify([
      { body: marked("old finding"), id: 55 },
      { body: "a human review comment", id: 66 },
      // a human quote-reply to one of our comments: contains the marker, but not at the start
      {
        body: quotedReply("old finding", "actually this is intentional"),
        id: 88,
      },
    ]);
    const { run, calls } = fakeRunner((args) =>
      isInlineList(args) ? { stdout: prior } : { stdout: "{}" }
    );

    await createGhPoster(run).postReview(TARGET, [
      { body: marked("b"), line: 1, path: "a.ts" },
    ]);

    const deletes = calls.filter((c) => c.args.includes("DELETE"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.args).toEqual([
      "api",
      "repos/o/r/pulls/comments/55",
      "--method",
      "DELETE",
    ]);
    // neither the plain human comment (66) nor the quote-reply (88) is deleted
    expect(
      calls.some((c) => c.args.includes("repos/o/r/pulls/comments/66"))
    ).toBe(false);
    expect(
      calls.some((c) => c.args.includes("repos/o/r/pulls/comments/88"))
    ).toBe(false);
    expect(
      calls.some((c) => c.args.includes("repos/o/r/pulls/7/reviews"))
    ).toBe(true);
  });

  test("clears stale inline comments even when the new set is empty (no review posted)", async () => {
    const prior = JSON.stringify([{ body: marked("stale"), id: 77 }]);
    const { run, calls } = fakeRunner((args) =>
      isInlineList(args) ? { stdout: prior } : { stdout: "{}" }
    );

    await createGhPoster(run).postReview(TARGET, []);

    expect(
      calls.some(
        (c) =>
          c.args.includes("repos/o/r/pulls/comments/77") &&
          c.args.includes("DELETE")
      )
    ).toBe(true);
    expect(
      calls.some((c) => c.args.includes("repos/o/r/pulls/7/reviews"))
    ).toBe(false);
  });

  test("a FAILED review POST does not delete the prior comments (never leaves the PR with zero of ours)", async () => {
    const prior = JSON.stringify([{ body: marked("old finding"), id: 55 }]);
    const { run, calls } = fakeRunner((args) => {
      if (isInlineList(args)) {
        return { stdout: prior };
      }
      if (args.includes("repos/o/r/pulls/7/reviews")) {
        return { code: 1, stderr: "500 server error" }; // the new review POST fails
      }
      return { stdout: "{}" };
    });

    await expect(
      createGhPoster(run).postReview(TARGET, [
        { body: marked("b"), line: 1, path: "a.ts" },
      ])
    ).rejects.toThrow();

    // post is attempted BEFORE any delete, so a post failure leaves the prior comment (55) intact — stale, but
    // present — instead of deleting it first and ending with zero of our comments on the PR.
    expect(calls.some((c) => c.args.includes("DELETE"))).toBe(false);
    expect(
      calls.some((c) => c.args.includes("repos/o/r/pulls/comments/55"))
    ).toBe(false);
  });

  test("surfaces a non-zero exit as a thrown error", async () => {
    const { run } = fakeRunner((args) =>
      isInlineList(args)
        ? { stdout: "[]" }
        : { code: 1, stderr: "422 Unprocessable" }
    );

    await expect(
      createGhPoster(run).postReview(TARGET, [
        { body: marked("b"), line: 1, path: "a.ts" },
      ])
    ).rejects.toThrow("422 Unprocessable");
  });
});

describe("createGhPoster.upsertSticky", () => {
  test("creates a new comment when none carries the sticky marker", async () => {
    const { run, calls } = fakeRunner((args) =>
      isWrite(args) ? { stdout: "{}" } : { stdout: "[]" }
    );

    await createGhPoster(run).upsertSticky(TARGET, STICKY);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      "api",
      "repos/o/r/issues/7/comments",
      "--paginate",
    ]);
    expect(calls[1]?.args).toEqual([
      "api",
      "repos/o/r/issues/7/comments",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    expect(JSON.parse(calls[1]?.input ?? "{}").body).toBe(STICKY);
  });

  test("updates the existing sticky comment in place", async () => {
    const existing = JSON.stringify([
      { body: "unrelated chatter", id: 100 },
      { body: `${STICKY} (previous run)`, id: 200 },
    ]);
    const { run, calls } = fakeRunner((args) =>
      isWrite(args) ? { stdout: "{}" } : { stdout: existing }
    );

    await createGhPoster(run).upsertSticky(TARGET, STICKY);

    expect(calls[1]?.args).toEqual([
      "api",
      "repos/o/r/issues/comments/200",
      "--method",
      "PATCH",
      "--input",
      "-",
    ]);
  });
});

describe("spawnRunner (real subprocess contract)", () => {
  test("writes input to stdin, captures stdout, and reports a zero exit", async () => {
    // `cat` with no args echoes stdin to stdout
    const res = await spawnRunner("cat")([], "hello stdin");

    expect(res).toEqual({ code: 0, stderr: "", stdout: "hello stdin" });
  });

  test("captures a non-zero exit and stderr", async () => {
    const res = await spawnRunner("cat")(["/no/such/path/sqw-xyz"]);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("sqw-xyz");
  });

  test("rejects when the binary is missing", async () => {
    await expect(
      spawnRunner("sqw-definitely-not-a-real-binary")([])
    ).rejects.toThrow();
  });
});

describe("createGhPullLookup", () => {
  test("lists open PRs whose HEAD is the commit and drops closed ones", async () => {
    const body = JSON.stringify([
      { head: { sha: "cafe1234" }, number: 7, state: "open" },
      { head: { sha: "cafe1234" }, number: 3, state: "closed" },
    ]);
    const { run, calls } = fakeRunner(() => ({ stdout: body }));

    const pulls = await createGhPullLookup(run)("o/r", "cafe1234");

    expect(pulls).toEqual([{ number: 7 }]);
    expect(calls[0]?.args).toEqual([
      "api",
      "repos/o/r/commits/cafe1234/pulls",
      "--paginate",
    ]);
  });

  test("drops a history-associated PR whose HEAD is a DIFFERENT commit (stacked-PR false-refusal fix)", async () => {
    // the endpoint returns PRs that merely have `sha` somewhere in their history; a stacked PR-B shares PR-A's
    // history but has its own head. Only the PR actually AT `sha` must count — else the >1 guard falsely refuses.
    const body = JSON.stringify([
      { head: { sha: "cafe1234" }, number: 7, state: "open" }, // PR-A: head IS the reviewed commit
      { head: { sha: "beef5678" }, number: 8, state: "open" }, // PR-B: stacked, head elsewhere
    ]);
    const { run } = fakeRunner(() => ({ stdout: body }));

    expect(await createGhPullLookup(run)("o/r", "cafe1234")).toEqual([
      { number: 7 },
    ]);
  });

  test("a force-pushed PR (head moved off the reviewed sha) resolves to zero → benign no-op", async () => {
    const body = JSON.stringify([
      { head: { sha: "moved999" }, number: 7, state: "open" },
    ]);
    const { run } = fakeRunner(() => ({ stdout: body }));

    expect(await createGhPullLookup(run)("o/r", "cafe1234")).toEqual([]);
  });
});

describe("createGhPoster.postComment", () => {
  test("posts a standalone PR comment (single POST, body as JSON over stdin)", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: "{}" }));

    await createGhPoster(run).postComment(TARGET, "a rule suggestion");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "api",
      "repos/o/r/issues/7/comments",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    expect(JSON.parse(calls[0]?.input ?? "{}").body).toBe("a rule suggestion");
  });

  test("surfaces a non-zero exit as a thrown error", () => {
    const { run } = fakeRunner(() => ({ code: 1, stderr: "boom" }));
    expect(createGhPoster(run).postComment(TARGET, "x")).rejects.toThrow(
      "boom"
    );
  });
});
