import { describe, expect, test } from "bun:test";
import type { Finding, ReviewContext } from "../core/types.js";
import { STICKY_MARKER } from "../output/render.js";
import type {
  PiWorker,
  RepoReader,
  WorkerRequest,
  WorkerResult,
} from "../pi/session.js";
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
    expect(out.sticky).toContain("No issues flagged by");
    // the persona has no `label`, so attribution falls back to its id (guards the `?? id` in runReview)
    expect(out.sticky).toContain("Reviewed by: gen");
  });

  test("forwards config.budget to the worker", async () => {
    let received: WorkerRequest | undefined;
    const worker: PiWorker = {
      run: (req) => {
        received = req;
        return Promise.resolve({
          findings: [],
          usage: { submitted: true, toolCalls: 0 },
        });
      },
    };

    await runReview(
      CONTEXT,
      { ...CONFIG, budget: { maxToolCalls: 30 } },
      worker
    );

    expect(received?.budget).toEqual({ maxToolCalls: 30 });
  });

  test("forwards no budget when the config has none", async () => {
    let received: WorkerRequest | undefined;
    const worker: PiWorker = {
      run: (req) => {
        received = req;
        return Promise.resolve({
          findings: [],
          usage: { submitted: true, toolCalls: 0 },
        });
      },
    };

    await runReview(CONTEXT, CONFIG, worker);

    expect(received?.budget).toBeUndefined();
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

  test("injects a matching Tier-A rule into the pass systemPrompt; excludes a non-matching one", async () => {
    let received: WorkerRequest | undefined;
    const worker: PiWorker = {
      run: (req) => {
        received = req;
        return Promise.resolve({
          findings: [],
          usage: { submitted: true, toolCalls: 0 },
        });
      },
    };
    const reader: RepoReader = {
      listDir: (path) =>
        Promise.resolve(
          path === ".review-rules" ? ["- ts.md", "- css.md"] : null
        ),
      readFile: (path) => {
        if (path === ".review-rules/ts.md") {
          return Promise.resolve(
            '---\nglobs: ["src/**"]\n---\n\nTS RULE: no default exports.'
          );
        }
        if (path === ".review-rules/css.md") {
          return Promise.resolve(
            '---\nglobs: ["**/*.css"]\n---\n\nCSS RULE: logical properties only.'
          );
        }
        return Promise.resolve(null);
      },
    };

    // CONTEXT changes src/a.ts → the src/** rule matches, the *.css rule does not.
    await runReview(CONTEXT, CONFIG, worker, { repoReader: reader });

    expect(received?.systemPrompt).toContain("TS RULE: no default exports.");
    expect(received?.systemPrompt).toContain("take precedence");
    expect(received?.systemPrompt).not.toContain("CSS RULE");
    // the persona's own prompt is still present, after the rule preamble
    expect(received?.systemPrompt).toContain("review it");
  });

  test("injects Tier-B contextDocs as background, ordered after Tier-A rules", async () => {
    let received: WorkerRequest | undefined;
    const worker: PiWorker = {
      run: (req) => {
        received = req;
        return Promise.resolve({
          findings: [],
          usage: { submitted: true, toolCalls: 0 },
        });
      },
    };
    const reader: RepoReader = {
      listDir: (path) =>
        Promise.resolve(path === ".review-rules" ? ["- ts.md"] : null),
      readFile: (path) => {
        if (path === ".review-rules/ts.md") {
          return Promise.resolve(
            '---\nglobs: ["src/**"]\n---\n\nRULE TEXT here.'
          );
        }
        if (path === "AGENTS.md") {
          return Promise.resolve("AGENTS DOC TEXT here.");
        }
        return Promise.resolve(null);
      },
    };
    const config: AssemblyConfig = {
      ...CONFIG,
      contextDocs: [{ globs: ["src/**"], path: "AGENTS.md" }],
    };

    await runReview(CONTEXT, config, worker, { repoReader: reader });

    const prompt = received?.systemPrompt ?? "";
    expect(prompt).toContain("RULE TEXT here.");
    expect(prompt).toContain("AGENTS DOC TEXT here.");
    // rules (precedence) before docs (background) before the persona prompt
    expect(prompt.indexOf("RULE TEXT here.")).toBeLessThan(
      prompt.indexOf("AGENTS DOC TEXT here.")
    );
    expect(prompt.indexOf("AGENTS DOC TEXT here.")).toBeLessThan(
      prompt.indexOf("review it")
    );
  });

  test("no repoReader leaves the systemPrompt untouched (bare persona prompt)", async () => {
    let received: WorkerRequest | undefined;
    const worker: PiWorker = {
      run: (req) => {
        received = req;
        return Promise.resolve({
          findings: [],
          usage: { submitted: true, toolCalls: 0 },
        });
      },
    };
    await runReview(CONTEXT, CONFIG, worker);
    expect(received?.systemPrompt).toBe("review it");
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
    expect(out.sticky).toContain("No issues flagged by");
  });
});
