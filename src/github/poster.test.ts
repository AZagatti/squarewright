import { describe, expect, test } from "bun:test";
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

describe("createGhPoster.postReview", () => {
  test("posts one review with commit_id and RIGHT-side inline comments", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: "{}" }));

    await createGhPoster(run).postReview(TARGET, [
      { body: "b1", line: 10, path: "a.ts" },
      { body: "b2", line: 20, path: "b.ts" },
    ]);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.args).toEqual([
      "api",
      "repos/o/r/pulls/7/reviews",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    const payload = JSON.parse(call?.input ?? "{}");
    expect(payload.event).toBe("COMMENT");
    expect(payload.commit_id).toBe("cafe1234");
    expect(payload.comments).toEqual([
      { body: "b1", line: 10, path: "a.ts", side: "RIGHT" },
      { body: "b2", line: 20, path: "b.ts", side: "RIGHT" },
    ]);
  });

  test("no-ops (no gh call) when there are no inline comments", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: "{}" }));

    await createGhPoster(run).postReview(TARGET, []);

    expect(calls).toEqual([]);
  });

  test("surfaces a non-zero exit as a thrown error", async () => {
    const { run } = fakeRunner(() => ({
      code: 1,
      stderr: "422 Unprocessable",
    }));

    await expect(
      createGhPoster(run).postReview(TARGET, [
        { body: "b", line: 1, path: "a.ts" },
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
