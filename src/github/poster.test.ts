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
const marked = (body: string) => `${body}\n\n${INLINE_MARKER}`;

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

  test("deletes our prior inline comments, leaves others, then posts", async () => {
    const prior = JSON.stringify([
      { body: marked("old finding"), id: 55 },
      { body: "a human review comment", id: 66 },
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
    // the human comment (66) is never deleted; the fresh review is still posted
    expect(
      calls.some((c) => c.args.includes("repos/o/r/pulls/comments/66"))
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
  test("lists open PRs for the commit and drops closed ones", async () => {
    const body = JSON.stringify([
      { number: 7, state: "open" },
      { number: 3, state: "closed" },
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
});
