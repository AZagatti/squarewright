import { describe, expect, spyOn, test } from "bun:test";
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

  test("forwards config.cotScaffold to the worker when opted in", async () => {
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

    await runReview(CONTEXT, { ...CONFIG, cotScaffold: true }, worker);

    expect(received?.cotScaffold).toBe(true);
  });

  test("cotScaffold is off (falsy) when the config doesn't set it", async () => {
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

    expect(received?.cotScaffold).toBeFalsy();
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
    // rules were adopted → rule-drift emission is enabled for this pass
    expect(received?.proposeRuleDrift).toBe(true);
  });

  test("warns (does not truncate) when the trusted rules+docs preamble is very large (cost visibility)", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {
      // silence + capture
    });
    // capture the request so we can assert the FULL trusted rule text reached the prompt (not truncated)
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
    // a single rule file well over the ~24k-char threshold
    const huge = "x".repeat(30_000);
    const bigReader: RepoReader = {
      listDir: (path) =>
        Promise.resolve(path === ".review-rules" ? ["- big.md"] : null),
      readFile: (path) =>
        Promise.resolve(
          path === ".review-rules/big.md"
            ? `---\nglobs: ["src/**"]\n---\n\n${huge}`
            : null
        ),
    };
    await runReview(CONTEXT, CONFIG, worker, { repoReader: bigReader });

    // warned about the oversized context…
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Project review context");
    // …but did NOT truncate — the full 30k-char trusted rule body still reaches the prompt intact
    expect(received?.systemPrompt).toContain(huge);
    warnSpy.mockRestore();
  });

  test("a normal-sized preamble does not warn", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {
      // silence
    });
    const worker = stubWorker({
      findings: [],
      usage: { submitted: true, toolCalls: 0 },
    });
    const reader: RepoReader = {
      listDir: (path) =>
        Promise.resolve(path === ".review-rules" ? ["- ts.md"] : null),
      readFile: (path) =>
        Promise.resolve(
          path === ".review-rules/ts.md"
            ? '---\nglobs: ["src/**"]\n---\n\nTS RULE: no default exports.'
            : null
        ),
    };
    await runReview(CONTEXT, CONFIG, worker, { repoReader: reader });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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
    // docs (Tier-B) count as adoption too → rule-drift enabled
    expect(received?.proposeRuleDrift).toBe(true);
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
    // no rules/docs adopted (empty preamble) → rule-drift emission stays OFF (no drift-noise for opted-out repos)
    expect(received?.proposeRuleDrift).toBe(false);
  });

  test("a pass that never submitted (usage.submitted=false) is disclosed as incomplete, not clean", async () => {
    // The exact shape worker.run returns when the structurer never calls submit_findings and the nudge loop
    // exhausts: empty findings + submitted:false. This must NOT ship as an indistinguishable clean review.
    const worker = stubWorker({
      findings: [],
      usage: { submitted: false, toolCalls: 1 },
    });
    const out = await runReview(CONTEXT, CONFIG, worker);

    expect(out.findings).toHaveLength(0);
    expect(out.sticky).toContain("Incomplete review");
    // the failing lens is named (falls back to its id, here "gen")
    expect(out.sticky).toContain("gen");
  });

  test("a pass that THROWS is isolated — other lenses' findings survive and it's disclosed", async () => {
    // A transient provider error on one lens must NOT abort the whole review and lose the others' real findings.
    const errSpy = spyOn(console, "error").mockImplementation(() => {
      // silence + capture the logged cause
    });
    // solo personas → each runs as its own pass (non-solo personas batch into one "baseline" pass, which
    // wouldn't exercise cross-pass isolation), so an error on pass "a" leaves pass "b" free to succeed.
    const config: AssemblyConfig = {
      grounders: [],
      lanes: [{ id: "cheap", model: "glm-5-turbo", provider: "zai" }],
      personas: [
        {
          id: "a",
          label: "L-a",
          lane: "cheap",
          prompt: "a",
          solo: true,
          when: ["always"],
        },
        {
          id: "b",
          label: "L-b",
          lane: "cheap",
          prompt: "b",
          solo: true,
          when: ["always"],
        },
      ],
    };
    const worker: PiWorker = {
      run: (req) =>
        req.persona === "a"
          ? Promise.reject(new Error("provider 503"))
          : Promise.resolve({
              findings: [finding(1)],
              usage: { submitted: true, toolCalls: 1 },
            }),
    };
    const out = await runReview(CONTEXT, config, worker);

    // b's real finding survived even though a threw
    expect(out.findings).toHaveLength(1);
    // the errored lens is disclosed (not silently dropped) and the cause is logged for CI
    expect(out.sticky).toContain("Review error");
    expect(out.sticky).toContain("L-a");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("provider 503");
    errSpy.mockRestore();
  });

  test("when every pass throws, the review still ships an all-errored sticky rather than crashing", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {
      // silence expected error logs
    });
    const worker: PiWorker = {
      run: () => Promise.reject(new Error("boom")),
    };
    const out = await runReview(CONTEXT, CONFIG, worker);

    expect(out.findings).toHaveLength(0);
    expect(out.sticky).toContain("Review error");
    expect(out.sticky).toContain("gen");
    errSpy.mockRestore();
  });

  test("a normal clean pass (submitted=true) carries no incomplete disclosure", async () => {
    const worker = stubWorker({
      findings: [],
      usage: { submitted: true, toolCalls: 1 },
    });
    const out = await runReview(CONTEXT, CONFIG, worker);
    expect(out.sticky).not.toContain("Incomplete review");
  });

  test("personas dropped by the MAX_PERSONAS cap are disclosed in the sticky", async () => {
    // 6 always-on personas on one lane; the cap (4) keeps the first four and drops the last two — which must be
    // named in the sticky, not silently omitted while the footer implies full coverage.
    const many: AssemblyConfig = {
      grounders: [],
      lanes: [{ id: "cheap", model: "glm-5-turbo", provider: "zai" }],
      personas: ["a", "b", "c", "d", "e", "f"].map((id) => ({
        id,
        label: `L-${id}`,
        lane: "cheap",
        prompt: id,
        when: ["always"],
      })),
    };
    const worker = stubWorker({
      findings: [],
      usage: { submitted: true, toolCalls: 1 },
    });
    const out = await runReview(CONTEXT, many, worker);

    expect(out.sticky).toContain("Coverage capped");
    expect(out.sticky).toContain("L-e");
    expect(out.sticky).toContain("L-f");
    // kept lenses are not falsely listed as dropped
    expect(out.sticky).toContain("2 matched lens");
  });

  test("AC persona runs as its own acCheck pass ONLY when the PR has a linkedIssue", async () => {
    const calls: WorkerRequest[] = [];
    const worker: PiWorker = {
      run: (req) => {
        calls.push(req);
        return Promise.resolve({
          findings: [],
          usage: { submitted: true, toolCalls: 0 },
        });
      },
    };
    const config: AssemblyConfig = {
      grounders: [],
      lanes: [
        { id: "cheap", model: "glm-5-turbo", provider: "zai" },
        { id: "strong", model: "big", provider: "openrouter" },
      ],
      personas: [
        { id: "gen", lane: "cheap", prompt: "review it", when: ["always"] },
        {
          acCheck: true,
          id: "auditor",
          label: "AC",
          lane: "strong",
          prompt: "check ACs",
        },
      ],
    };

    // no linkedIssue → the auditor does NOT run; no acCheck request anywhere
    await runReview(CONTEXT, config, worker);
    expect(calls.some((c) => c.persona === "auditor")).toBe(false);
    expect(calls.some((c) => c.acCheck)).toBe(false);

    // with a linkedIssue → the auditor runs as its own acCheck pass on the STRONG lane
    calls.length = 0;
    const withIssue: ReviewContext = {
      ...CONTEXT,
      linkedIssue: { body: "AC: do X", number: 5, title: "T" },
    };
    await runReview(withIssue, config, worker);
    const ac = calls.find((c) => c.persona === "auditor");
    expect(ac).toBeDefined();
    expect(ac?.acCheck).toBe(true);
    expect(ac?.lane.model).toBe("big"); // resolved to the strong lane
    // the defect persona still runs, and WITHOUT acCheck (no issue-text leak into it)
    const gen = calls.find((c) => c.persona === "gen");
    expect(gen?.acCheck).toBeFalsy();
  });

  test("an AC pass that THROWS is isolated — persona findings survive and the AC lens is disclosed", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {
      // silence + capture the logged cause
    });
    const config: AssemblyConfig = {
      grounders: [],
      lanes: [
        { id: "cheap", model: "glm-5-turbo", provider: "zai" },
        { id: "strong", model: "big", provider: "openrouter" },
      ],
      personas: [
        { id: "gen", lane: "cheap", prompt: "review it", when: ["always"] },
        {
          acCheck: true,
          id: "auditor",
          label: "AC",
          lane: "strong",
          prompt: "check ACs",
        },
      ],
    };
    // the AC pass (acCheck:true) throws; the defect persona succeeds with a real finding
    const worker: PiWorker = {
      run: (req) =>
        req.acCheck
          ? Promise.reject(new Error("AC provider 500"))
          : Promise.resolve({
              findings: [finding(1)],
              usage: { submitted: true, toolCalls: 1 },
            }),
    };
    const withIssue: ReviewContext = {
      ...CONTEXT,
      linkedIssue: { body: "AC: do X", number: 5, title: "T" },
    };
    const out = await runReview(withIssue, config, worker);

    // the defect persona's finding survived the AC pass's error
    expect(out.findings).toHaveLength(1);
    // the AC lens is disclosed as errored (never silently dropped) and its cause is logged
    expect(out.sticky).toContain("Review error");
    expect(out.sticky).toContain("AC");
    expect(errSpy.mock.calls[0]?.[0]).toContain("AC provider 500");
    errSpy.mockRestore();
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
