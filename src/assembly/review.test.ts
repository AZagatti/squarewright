import { describe, expect, test } from "bun:test";
import type { Finding, ReviewContext } from "../core/types.js";
import { STICKY_MARKER } from "../output/render.js";
import type { PiWorker, WorkerResult } from "../pi/session.js";
import type { AssemblyConfig } from "./config.js";
import { runReview } from "./review.js";

/** A PiWorker that returns the same canned result for every pass. */
function stubWorker(result: WorkerResult): PiWorker {
  return { run: () => Promise.resolve(result) };
}

/** One modified file whose patch makes new-side lines 1 and 2 commentable. */
const CONTEXT: ReviewContext = {
  baseSha: "",
  body: "",
  files: [
    {
      patch: "@@ -1,1 +1,2 @@\n context\n+added line\n",
      path: "src/a.ts",
      status: "modified",
    },
  ],
  headSha: "",
  prNumber: 1,
  repo: "o/r",
  title: "t",
};

const CONFIG: AssemblyConfig = {
  grounders: [],
  lanes: [{ id: "cheap", model: "glm-5-turbo", provider: "zai" }],
  personas: [
    { id: "gen", lane: "cheap", prompt: "review it", when: ["always"] },
  ],
};

function finding(line: number): Finding {
  return {
    line,
    message: "a real problem here",
    path: "src/a.ts",
    rule: "persona:gen",
    severity: "warning",
    source: "gen",
  };
}

describe("runReview", () => {
  test("composes worker findings into sticky + inline output", async () => {
    const worker = stubWorker({
      findings: [finding(1)],
      usage: { submitted: true, summary: "one issue", toolCalls: 1 },
    });
    const out = await runReview(CONTEXT, CONFIG, worker);

    expect(out.findings).toHaveLength(1);
    expect(out.sticky).toContain(STICKY_MARKER);
    expect(out.sticky).toContain("a real problem here");
    // line 1 is commentable → placed inline, nothing unplaceable
    expect(out.inline).toHaveLength(1);
    expect(out.inline[0]?.line).toBe(1);
    expect(out.unplaceable).toHaveLength(0);
  });

  test("routes a finding off the diff to unplaceable (still in the sticky)", async () => {
    const worker = stubWorker({
      findings: [finding(99)],
      usage: { submitted: true, toolCalls: 1 },
    });
    const out = await runReview(CONTEXT, CONFIG, worker);

    expect(out.inline).toHaveLength(0);
    expect(out.unplaceable).toHaveLength(1);
    expect(out.sticky).toContain("a real problem here");
  });

  test("clean review renders the no-issues sticky", async () => {
    const worker = stubWorker({
      findings: [],
      usage: { submitted: true, toolCalls: 1 },
    });
    const out = await runReview(CONTEXT, CONFIG, worker);

    expect(out.findings).toHaveLength(0);
    expect(out.inline).toHaveLength(0);
    expect(out.sticky).toContain("No blocking issues found");
  });

  test("fails fast when a persona's lane is not defined (no silent fallback)", () => {
    const badConfig: AssemblyConfig = {
      grounders: [],
      lanes: [{ id: "cheap", model: "glm-5-turbo", provider: "zai" }],
      personas: [
        { id: "gen", lane: "does-not-exist", prompt: "x", when: ["always"] },
      ],
    };
    const worker = stubWorker({
      findings: [],
      usage: { submitted: true, toolCalls: 0 },
    });
    expect(runReview(CONTEXT, badConfig, worker)).rejects.toThrow(
      "not defined"
    );
  });

  // Two always-on, non-solo personas → buildPasses batches them into ONE pass spanning two lanes.
  const twoLanes = [
    { id: "cheap", model: "glm-5-turbo", provider: "zai" },
    { id: "strong", model: "big", provider: "openrouter" },
  ];
  const batchedPersonas = [
    { id: "a", lane: "cheap", prompt: "x", when: ["always"] },
    { id: "b", lane: "strong", prompt: "y", when: ["always"] },
  ];

  test("batched pass spanning lanes resolves via defaultLane", async () => {
    const config: AssemblyConfig = {
      defaultLane: "cheap",
      grounders: [],
      lanes: twoLanes,
      personas: batchedPersonas,
    };
    const worker = stubWorker({
      findings: [finding(1)],
      usage: { submitted: true, toolCalls: 1 },
    });
    const out = await runReview(CONTEXT, config, worker);
    expect(out.findings).toHaveLength(1);
  });

  test("batched pass spanning lanes with no defaultLane fails fast", () => {
    const config: AssemblyConfig = {
      grounders: [],
      lanes: twoLanes,
      personas: batchedPersonas,
    };
    const worker = stubWorker({
      findings: [],
      usage: { submitted: true, toolCalls: 0 },
    });
    expect(runReview(CONTEXT, config, worker)).rejects.toThrow(
      "different lanes"
    );
  });

  test("docs-only PR selects no personas and never calls the worker", async () => {
    let calls = 0;
    const worker: PiWorker = {
      run: () => {
        calls += 1;
        return Promise.resolve({
          findings: [],
          usage: { submitted: true, toolCalls: 0 },
        });
      },
    };
    const docsContext: ReviewContext = {
      ...CONTEXT,
      files: [
        {
          patch: "@@ -1,1 +1,2 @@\n a\n+b\n",
          path: "README.md",
          status: "modified",
        },
      ],
    };
    const config: AssemblyConfig = {
      grounders: [],
      lanes: [{ id: "cheap", model: "glm-5-turbo", provider: "zai" }],
      personas: [
        {
          id: "gen",
          lane: "cheap",
          needsCode: true,
          prompt: "x",
          when: ["always"],
        },
      ],
    };
    const out = await runReview(docsContext, config, worker);
    expect(calls).toBe(0);
    expect(out.sticky).toContain("No blocking issues found");
  });
});
