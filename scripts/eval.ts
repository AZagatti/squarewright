/**
 * Golden-PRs eval runner. Reproducible model comparison over a frozen corpus.
 *
 *   bun run scripts/eval.ts --freeze                 # fetch+freeze any missing diffs (no model calls)
 *   bun run scripts/eval.ts --model deepseek/deepseek-v3.2 --verify
 *   bun run scripts/eval.ts --model x --stack rust --concurrency 4
 *
 * Corpus:  eval/golden/manifest.yaml + eval/golden/diffs/<id>.diff  (both committed = the golden fixtures)
 * Reports: eval/reports/<model>-<stamp>.json                        (gitignored run artifacts)
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { splitUnifiedDiff } from "../src/core/diff.js";
import type {
  Finding,
  ReviewContext,
  ThinkingLevel,
} from "../src/core/types.js";
import { aggregateFindings } from "../src/output/aggregate.js";
import { buildPasses, DEFAULT_PERSONAS } from "../src/personas/defaults.js";
import { selectPersonas } from "../src/personas/routing.js";
import type { RepoReader } from "../src/pi/session.js";
import { createVerifier } from "../src/pi/verifier.js";
import { createPiWorker } from "../src/pi/worker.js";

const PERSONA = `You are a careful senior code reviewer reviewing a single pull request.
Review ONLY the changes in the diff. Flag correctness bugs, security issues, and clear regressions.
Ground every finding in the diff — do not speculate about code you cannot see. Prefer a few high-signal
findings over many nits. If the change looks fine, submit an empty findings array.`;

const ROOT = new URL("..", import.meta.url).pathname;
const DIFF_DIR = `${ROOT}eval/golden/diffs`;
const REPORT_DIR = `${ROOT}eval/reports`;

interface Locus {
  about: string;
  path: string;
}
interface Case {
  evidence?: string;
  expect_loci?: Locus[];
  id: string;
  kind?: string;
  label: "clean" | "has-issue";
  note?: string;
  pr: number;
  repo: string;
  stack: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function readKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  try {
    keys.openrouter = (
      process.env.OPENROUTER_API_KEY ??
      readFileSync(`${homedir()}/.or_key`, "utf8")
    ).trim();
  } catch {
    /* no OpenRouter key */
  }
  try {
    keys.zai = (
      process.env.ZAI_API_KEY ?? readFileSync(`${homedir()}/.zai_key`, "utf8")
    ).trim();
  } catch {
    /* no z.ai key */
  }
  return keys;
}

/** Authoritative spend: OpenRouter's own credits balance (Pi's usage.cost undercounts reasoning tokens). */
function openrouterCredits(): number | null {
  try {
    const key = readFileSync("/tmp/openrouter_mgm_key", "utf8").trim();
    const out = execFileSync(
      "curl",
      [
        "-s",
        "https://openrouter.ai/api/v1/credits",
        "-H",
        `Authorization: Bearer ${key}`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const d = JSON.parse(out).data;
    return d.total_credits - d.total_usage;
  } catch {
    return null;
  }
}

/**
 * Will running this OpenRouter model at `--thinking off` still bill (expensive) reasoning tokens?
 * Pi sends `reasoning:{effort:"none"}` for off, but that only helps if the model actually honours it. It does NOT when:
 *  - reasoning.mandatory=true (minimax-m2.x, gpt-oss/gpt-5): the model reasons regardless (~$4.8 burn), OR
 *  - the model only supports high/xhigh efforts with no cheap tier (deepseek-v4-flash: supported ["xhigh","high"],
 *    default "high"): "none" is unsupported → OpenRouter falls back to default_effort → full reasoning ($0.96 burn).
 * A true disable would need `reasoning:{enabled:false}` (Pi can't send it) or the model's native provider.
 */
function openrouterReasoningRisk(model: string): {
  block: boolean;
  detail: string;
} {
  try {
    const out = execFileSync(
      "curl",
      ["-s", "https://openrouter.ai/api/v1/models"],
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const m = (
      JSON.parse(out).data as Array<{ id: string; reasoning?: unknown }>
    ).find((x) => x.id === model);
    if (!m) {
      return { block: false, detail: "model not found in OpenRouter catalog" };
    }
    const r = m.reasoning as
      | {
          mandatory?: boolean;
          supported_efforts?: string[];
          default_effort?: string;
        }
      | undefined;
    if (!r || typeof r !== "object") {
      return { block: false, detail: "no reasoning (safe)" };
    }
    if (r.mandatory) {
      return {
        block: true,
        detail: "reasoning.mandatory=true — reasoning cannot be disabled",
      };
    }
    const efforts = r.supported_efforts ?? [];
    const cheap = efforts.some((e) =>
      ["none", "minimal", "low", "medium"].includes(e)
    );
    if (efforts.length > 0 && !cheap) {
      return {
        block: true,
        detail: `only supports efforts [${efforts.join(", ")}] (default ${r.default_effort}) — 'off' falls back to expensive reasoning`,
      };
    }
    return { block: false, detail: "reasoning disableable at off (safe)" };
  } catch {
    return { block: false, detail: "reasoning-risk check failed (proceeding)" };
  }
}

/** Per-token price ($/token) for an OpenRouter model — used for the immediate, lag-free local spend guard. */
function openrouterPrice(model: string): { in: number; out: number } {
  try {
    const out = execFileSync(
      "curl",
      ["-s", "https://openrouter.ai/api/v1/models"],
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const m = (
      JSON.parse(out).data as Array<{
        id: string;
        pricing?: { prompt?: string; completion?: string };
      }>
    ).find((x) => x.id === model);
    return {
      in: Number(m?.pricing?.prompt) || 0,
      out: Number(m?.pricing?.completion) || 0,
    };
  } catch {
    return { in: 0, out: 0 };
  }
}

const headShaCache = new Map<string, string>();
function headSha(repo: string, pr: number): string {
  const k = `${repo}#${pr}`;
  const cached = headShaCache.get(k);
  if (cached) {
    return cached;
  }
  const sha = execFileSync(
    "gh",
    [
      "pr",
      "view",
      String(pr),
      "--repo",
      repo,
      "--json",
      "headRefOid",
      "-q",
      ".headRefOid",
    ],
    {
      encoding: "utf8",
    }
  ).trim();
  headShaCache.set(k, sha);
  return sha;
}

/** RepoReader backed by the GitHub contents API at the PR's head SHA (immutable => reproducible). */
function ghRepoReader(repo: string, pr: number): RepoReader {
  const sha = headSha(repo, pr);
  const fetch = (path: string): unknown => {
    const q = path
      ? `repos/${repo}/contents/${path}?ref=${sha}`
      : `repos/${repo}/contents?ref=${sha}`;
    return JSON.parse(
      execFileSync("gh", ["api", q], {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
  };
  return {
    listDir(path) {
      try {
        const j = fetch(path);
        if (!Array.isArray(j)) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          (j as { name: string; type: string }[]).map(
            (e) => `${e.type === "dir" ? "d" : "-"} ${e.name}`
          )
        );
      } catch {
        return Promise.resolve(null);
      }
    },
    readFile(path) {
      try {
        const j = fetch(path) as
          | { encoding?: string; content?: string }
          | unknown[];
        if (Array.isArray(j)) {
          return Promise.resolve(null);
        }
        const f = j as { encoding?: string; content?: string };
        return Promise.resolve(
          f.encoding === "base64" && f.content
            ? Buffer.from(f.content, "base64").toString("utf8")
            : null
        );
      } catch {
        return Promise.resolve(null);
      }
    },
  };
}
function loadCases(): Case[] {
  const doc = parseYaml(
    readFileSync(`${ROOT}eval/golden/manifest.yaml`, "utf8")
  ) as { cases: Case[] };
  // biome-ignore lint/suspicious/noUnnecessaryConditions: runtime guard against a malformed/empty manifest.yaml — the `as` cast doesn't validate the parsed YAML at runtime
  let cases = doc.cases ?? [];
  const stack = arg("stack");
  const id = arg("id");
  if (stack) {
    cases = cases.filter((c) => c.stack === stack);
  }
  if (id) {
    cases = cases.filter((c) => c.id === id);
  }
  const label = arg("label");
  if (label) {
    cases = cases.filter((c) => c.label === label);
  }
  const limit = arg("limit");
  if (limit) {
    cases = cases.slice(0, Number(limit));
  }
  return cases;
}
function diffPath(id: string): string {
  return `${DIFF_DIR}/${id}.diff`;
}

function freeze(cases: Case[]): void {
  mkdirSync(DIFF_DIR, { recursive: true });
  for (const c of cases) {
    const p = diffPath(c.id);
    if (existsSync(p)) {
      console.log(`  have   ${c.id}`);
      continue;
    }
    try {
      const diff = execFileSync(
        "gh",
        ["pr", "diff", String(c.pr), "--repo", c.repo],
        {
          encoding: "utf8",
          maxBuffer: 50 * 1024 * 1024,
        }
      );
      writeFileSync(p, diff);
      console.log(`  froze  ${c.id}  (${diff.length} chars)`);
    } catch (e) {
      console.log(`  FAIL   ${c.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function pool<T, R>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from(
    { length: Math.min(n, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i;
        i += 1;
        // biome-ignore lint/style/noNonNullAssertion: idx < items.length is guaranteed by the while condition above — a bounds-checked index, not a nullable value
        // biome-ignore lint/performance/noAwaitInLoops: pool() itself IS the concurrency primitive — each of the `n` workers awaits its own items sequentially, capping in-flight calls at n
        out[idx] = await fn(items[idx]!);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: refactor tracked separately — behavior-preserving change out of scope for the tooling PR
async function main() {
  const cases = loadCases();

  if (flag("freeze")) {
    console.log(`freezing ${cases.length} case diff(s)…`);
    freeze(cases);
    return;
  }

  const provider = arg("provider") ?? "openrouter";
  const model =
    arg("model") ?? process.env.SW_MODEL ?? "deepseek/deepseek-v3.2";
  const thinking = (arg("thinking") ?? "off") as ThinkingLevel;
  const doVerify = flag("verify");
  const doGround = flag("ground");
  const doPersonas = flag("personas");
  const thinkingSet = arg("thinking") !== undefined;
  const concurrency = Number(arg("concurrency") ?? 3);
  const keys = readKeys();
  // Pass-2 structurer override, e.g. --structurer zai:glm-4.5-air (free) or openrouter:qwen/qwen3-coder-30b-a3b-instruct
  const structArg = arg("structurer");
  const structurerLane = structArg
    ? {
        id: "structurer",
        model: structArg.slice(structArg.indexOf(":") + 1),
        provider: structArg.slice(0, structArg.indexOf(":")),
        thinking: "off" as ThinkingLevel,
      }
    : undefined;
  const worker = createPiWorker({ apiKeys: keys, structurerLane });
  const verifier = doVerify ? createVerifier({ apiKeys: keys }) : undefined;
  const lane = { id: "eval", model, provider, thinking };

  // real-spend guard: default structurer is OpenRouter (qwen3-coder), so any run touches OR unless overridden to z.ai
  const usesOR =
    provider === "openrouter" ||
    (structurerLane ? structurerLane.provider === "openrouter" : true);

  // guardrail: refuse OpenRouter reasoning models that can't run cheap at low effort (they fall back to
  // expensive reasoning). Skipped if you explicitly ask for high/xhigh reasoning or pass --allow-reasoning-burn.
  if (
    provider === "openrouter" &&
    thinking !== "high" &&
    thinking !== "xhigh" &&
    !flag("allow-reasoning-burn")
  ) {
    const risk = openrouterReasoningRisk(model);
    if (risk.block) {
      console.error(
        `\n✋ ABORT: ${model} — ${risk.detail}.\n` +
          "   At low/off effort it still bills expensive reasoning tokens (minimax burned ~$4.8; deepseek-v4-flash ~$0.96/run).\n" +
          "   Use a model whose reasoning disables cheaply (deepseek-v3.2, xiaomi/mimo-v2.5, qwen3.5-flash, or a non-reasoning model),\n" +
          "   or run it intentionally with --thinking high, or pass --allow-reasoning-burn.\n"
      );
      process.exit(2);
    }
  }

  const creditsBefore = usesOR ? openrouterCredits() : null;

  // REAL-TIME SPEND CIRCUIT BREAKER — the only reliable protection. Metadata (mandatory/efforts) missed
  // mimo-v2.5, which looked safe but force-reasoned and burned ~$6.6. This checks actual OR credits during
  // the run and aborts the moment this run's spend exceeds --max-spend (default $0.50).
  const maxSpend = Number(arg("max-spend") ?? 0.5);
  const analysisPrice =
    provider === "openrouter" ? openrouterPrice(model) : { in: 0, out: 0 };
  const structModelId =
    structurerLane?.model ?? "qwen/qwen3-coder-30b-a3b-instruct";
  const structPrice =
    (structurerLane?.provider ?? "openrouter") === "openrouter"
      ? openrouterPrice(structModelId)
      : { in: 0, out: 0 };
  /** immediate $ estimate from a worker call's token usage (no credit-endpoint lag) */
  const passSpend = (u?: {
    analysisTokens?: { input: number; output: number };
    structTokens?: { input: number; output: number };
  }) => {
    const a = u?.analysisTokens ?? { input: 0, output: 0 };
    const s = u?.structTokens ?? { input: 0, output: 0 };
    return (
      a.input * analysisPrice.in +
      a.output * analysisPrice.out +
      s.input * structPrice.in +
      s.output * structPrice.out
    );
  };
  let localSpend = 0;
  let aborted = false;
  const spendGuard = () => {
    if (aborted || localSpend <= maxSpend) {
      return;
    }
    aborted = true;
    console.error(
      `\n🛑 CIRCUIT BREAKER: this run has spent ~$${localSpend.toFixed(4)} (local token estimate > --max-spend $${maxSpend}). Aborting remaining cases.`
    );
  };

  const missing = cases.filter((c) => !existsSync(diffPath(c.id)));
  if (missing.length) {
    console.error(
      `Missing frozen diffs for: ${missing.map((c) => c.id).join(", ")}. Run --freeze first.`
    );
    process.exit(1);
  }

  const structDesc = structurerLane
    ? `${structurerLane.provider}/${structurerLane.model}`
    : "openrouter/qwen3-coder-30b";
  console.log(
    `\n▸ eval  model=${provider}/${model}  structurer=${structDesc}  personas=${doPersonas}  thinking=${thinkingSet ? thinking : "per-persona"}  ground=${doGround}  verify=${doVerify}  cases=${cases.length}  conc=${concurrency}`
  );
  if (creditsBefore !== null) {
    console.log(`  OpenRouter credits before: $${creditsBefore.toFixed(4)}`);
  }
  console.log();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: refactor tracked separately — behavior-preserving change out of scope for the tooling PR
  const rawResults = await pool(cases, concurrency, async (c) => {
    spendGuard();
    if (aborted) {
      return null;
    }
    const diff = readFileSync(diffPath(c.id), "utf8").slice(0, 60_000);
    const context: ReviewContext = {
      baseSha: "",
      body: "",
      files: splitUnifiedDiff(diff),
      headSha: "",
      prNumber: c.pr,
      repo: c.repo,
      title: `${c.repo}#${c.pr}`,
    };
    const repoReader = doGround ? ghRepoReader(c.repo, c.pr) : undefined;
    const t0 = Date.now();
    let findings: Finding[];
    let workerCost = 0;
    let noSubmit = 0; // passes where the model never called submit_findings (NOT a clean review — a dropped submission)
    if (doPersonas) {
      const selected = selectPersonas(DEFAULT_PERSONAS, context.files, {
        cap: 4,
      });
      const passes = buildPasses(selected);
      const all: Finding[] = [];
      for (const pass of passes) {
        const passLane = {
          ...lane,
          thinking: thinkingSet ? thinking : pass.thinking,
        };
        // biome-ignore lint/performance/noAwaitInLoops: sequential by design — each pass feeds the local spend guard (spendGuard/aborted) checked right after, so later passes must know the running spend before firing
        const pr = await worker.run({
          context,
          lane: passLane,
          persona: pass.id,
          repoReader,
          systemPrompt: pass.prompt,
        });
        all.push(...pr.findings);
        workerCost += pr.usage?.costUsd ?? 0;
        localSpend += passSpend(pr.usage);
        if (!pr.usage?.submitted) {
          noSubmit += 1;
        }
        spendGuard();
        if (aborted) {
          break;
        }
      }
      findings = aggregateFindings(all);
    } else {
      const pr = await worker.run({
        context,
        lane,
        persona: "persona:general",
        repoReader,
        systemPrompt: PERSONA,
      });
      ({ findings } = pr);
      workerCost += pr.usage?.costUsd ?? 0;
      localSpend += passSpend(pr.usage);
      if (!pr.usage?.submitted) {
        noSubmit += 1;
      }
    }
    let confirmed = findings.length;
    let verifyCost = 0;
    if (verifier) {
      confirmed = 0;
      for (const f of findings) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential by design — respects the model provider's concurrency limits when verifying one case's findings
        const v = await verifier.verify(f, context, lane);
        verifyCost += v.usage?.costUsd ?? 0;
        if (v.verdict === "confirmed") {
          confirmed += 1;
        }
      }
    }
    const ms = Date.now() - t0;
    // has-issue recall: a finding on the same file as an expected locus counts as a hit (boundary-safe;
    // NOTE this is file-level only — it cannot see root-cause/precision; a judge scorer is the real fix).
    const sameFile = (fp: string, lp: string) =>
      fp === lp ||
      fp.endsWith(`/${lp}`) ||
      lp.endsWith(`/${fp}`) ||
      fp.split("/").pop() === lp.split("/").pop();
    const lociTotal = c.expect_loci?.length ?? 0;
    const hitLoci =
      c.expect_loci?.filter((l) =>
        findings.some((f) => sameFile(f.path, l.path))
      ).length ?? 0;
    const line = `[${c.label === "clean" ? "clean    " : "has-issue"}] ${c.id.padEnd(28)} raw=${findings.length} ${
      verifier ? `confirmed=${confirmed} ` : ""
    }${lociTotal ? `hits=${hitLoci}/${lociTotal} ` : ""}${noSubmit ? `nosub=${noSubmit} ` : ""}$${(workerCost + verifyCost).toFixed(4)} ${(ms / 1000).toFixed(0)}s`;
    console.log(line);
    return {
      confirmed,
      costUsd: workerCost + verifyCost,
      findings: findings.map((f) => ({
        line: f.line,
        message: f.message,
        path: f.path,
        severity: f.severity,
      })),
      hitLoci,
      id: c.id,
      label: c.label,
      lociTotal,
      ms,
      noSubmit,
      rawFindings: findings.length,
      stack: c.stack,
    };
  });

  // aggregate (drop any cases skipped by the circuit breaker)
  const results = rawResults.filter(
    (r): r is NonNullable<typeof r> => r !== null
  );
  if (aborted) {
    console.log(
      `  (circuit breaker: ${cases.length - results.length} cases skipped)`
    );
  }
  const clean = results.filter((r) => r.label === "clean");
  const issue = results.filter((r) => r.label === "has-issue");
  const cleanFP = clean.reduce(
    (s, r) => s + (doVerify ? r.confirmed : r.rawFindings),
    0
  );
  const issueHits = issue.reduce((s, r) => s + r.hitLoci, 0);
  const issueTotal = issue.reduce((s, r) => s + r.lociTotal, 0);
  const cost = results.reduce((s, r) => s + r.costUsd, 0);
  const secs = results.reduce((s, r) => s + r.ms, 0) / 1000;

  const totalNoSubmit = results.reduce((s, r) => s + (r.noSubmit ?? 0), 0);
  const config = {
    ground: doGround,
    model,
    personas: doPersonas,
    provider,
    thinking: thinkingSet ? thinking : "per-persona",
    verify: doVerify,
  };

  console.log(`\n── ${provider}/${model} ──`);
  console.log(
    `  clean cases: ${clean.length}  ·  false positives (${doVerify ? "post-verify" : "raw"}): ${cleanFP}`
  );
  console.log(
    `  has-issue cases: ${issue.length}  ·  locus recall: ${issueHits}/${issueTotal}`
  );
  if (totalNoSubmit) {
    console.log(
      `  ⚠ dropped submissions (model never called submit_findings): ${totalNoSubmit}`
    );
  }
  console.log(
    `  reported cost (undercounts reasoning): $${cost.toFixed(4)}  ·  total model-time: ${secs.toFixed(0)}s`
  );
  const creditsAfter = usesOR ? openrouterCredits() : null;
  const realCost =
    creditsBefore !== null && creditsAfter !== null
      ? creditsBefore - creditsAfter
      : null;
  if (realCost !== null) {
    console.log(
      `  💳 REAL OpenRouter spend: $${realCost.toFixed(4)}  ·  remaining: $${creditsAfter?.toFixed(4)}`
    );
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `${REPORT_DIR}/${model.replace(/\//g, "_")}-${stamp}.json`;
  writeFileSync(
    reportPath,
    JSON.stringify(
      { cleanFP, config, cost, issueHits, issueTotal, results, totalNoSubmit },
      null,
      2
    )
  );
  // durable, committed run log (one line per run) for cost/quality tracking across configs/models
  appendFileSync(
    `${ROOT}eval/runs.jsonl`,
    `${JSON.stringify({
      stamp,
      ...config,
      cleanCases: clean.length,
      cleanFP,
      issueCases: issue.length,
      issueHits,
      issueTotal,
      modelSeconds: Number(secs.toFixed(0)),
      realCostUsd: realCost === null ? null : Number(realCost.toFixed(4)),
      reportedCost: Number(cost.toFixed(4)),
      totalNoSubmit,
    })}\n`
  );
  console.log(`\n  report: ${reportPath}  ·  logged to eval/runs.jsonl\n`);
}

main().catch((e) => {
  console.error("eval failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
