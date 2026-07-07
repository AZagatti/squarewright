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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { createPiWorker } from "../src/pi/worker.js";
import { createVerifier } from "../src/pi/verifier.js";
import { splitUnifiedDiff } from "../src/core/diff.js";
import { selectPersonas } from "../src/personas/routing.js";
import { buildPasses, DEFAULT_PERSONAS } from "../src/personas/defaults.js";
import { aggregateFindings } from "../src/output/aggregate.js";
import type { Finding, ReviewContext, ThinkingLevel } from "../src/core/types.js";
import type { RepoReader } from "../src/pi/session.js";

const PERSONA = `You are a careful senior code reviewer reviewing a single pull request.
Review ONLY the changes in the diff. Flag correctness bugs, security issues, and clear regressions.
Ground every finding in the diff — do not speculate about code you cannot see. Prefer a few high-signal
findings over many nits. If the change looks fine, submit an empty findings array.`;

const ROOT = new URL("..", import.meta.url).pathname;
const DIFF_DIR = `${ROOT}eval/golden/diffs`;
const REPORT_DIR = `${ROOT}eval/reports`;

interface Locus {
  path: string;
  about: string;
}
interface Case {
  id: string;
  repo: string;
  pr: number;
  stack: string;
  kind?: string;
  label: "clean" | "has-issue";
  note?: string;
  evidence?: string;
  expect_loci?: Locus[];
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
    keys.openrouter = (process.env.OPENROUTER_API_KEY ?? readFileSync(`${homedir()}/.or_key`, "utf8")).trim();
  } catch {
    /* no OpenRouter key */
  }
  try {
    keys.zai = (process.env.ZAI_API_KEY ?? readFileSync(`${homedir()}/.zai_key`, "utf8")).trim();
  } catch {
    /* no z.ai key */
  }
  return keys;
}

/** Authoritative spend: OpenRouter's own credits balance (Pi's usage.cost undercounts reasoning tokens). */
function openrouterCredits(): number | null {
  try {
    const key = readFileSync("/tmp/openrouter_mgm_key", "utf8").trim();
    const out = execFileSync("curl", ["-s", "https://openrouter.ai/api/v1/credits", "-H", `Authorization: Bearer ${key}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
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
function openrouterReasoningRisk(model: string): { block: boolean; detail: string } {
  try {
    const out = execFileSync("curl", ["-s", "https://openrouter.ai/api/v1/models"], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = (JSON.parse(out).data as Array<{ id: string; reasoning?: unknown }>).find((x) => x.id === model);
    if (!m) return { block: false, detail: "model not found in OpenRouter catalog" };
    const r = m.reasoning as { mandatory?: boolean; supported_efforts?: string[]; default_effort?: string } | undefined;
    if (!r || typeof r !== "object") return { block: false, detail: "no reasoning (safe)" };
    if (r.mandatory) return { block: true, detail: "reasoning.mandatory=true — reasoning cannot be disabled" };
    const efforts = r.supported_efforts ?? [];
    const cheap = efforts.some((e) => ["none", "minimal", "low", "medium"].includes(e));
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

const headShaCache = new Map<string, string>();
function headSha(repo: string, pr: number): string {
  const k = `${repo}#${pr}`;
  const cached = headShaCache.get(k);
  if (cached) return cached;
  const sha = execFileSync("gh", ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"], {
    encoding: "utf8",
  }).trim();
  headShaCache.set(k, sha);
  return sha;
}

/** RepoReader backed by the GitHub contents API at the PR's head SHA (immutable => reproducible). */
function ghRepoReader(repo: string, pr: number): RepoReader {
  const sha = headSha(repo, pr);
  const fetch = (path: string): unknown => {
    const q = path ? `repos/${repo}/contents/${path}?ref=${sha}` : `repos/${repo}/contents?ref=${sha}`;
    return JSON.parse(
      execFileSync("gh", ["api", q], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }),
    );
  };
  return {
    async readFile(path) {
      try {
        const j = fetch(path) as { encoding?: string; content?: string } | unknown[];
        if (Array.isArray(j)) return null;
        const f = j as { encoding?: string; content?: string };
        return f.encoding === "base64" && f.content ? Buffer.from(f.content, "base64").toString("utf8") : null;
      } catch {
        return null;
      }
    },
    async listDir(path) {
      try {
        const j = fetch(path);
        if (!Array.isArray(j)) return null;
        return (j as { name: string; type: string }[]).map((e) => `${e.type === "dir" ? "d" : "-"} ${e.name}`);
      } catch {
        return null;
      }
    },
  };
}
function loadCases(): Case[] {
  const doc = parseYaml(readFileSync(`${ROOT}eval/golden/manifest.yaml`, "utf8")) as { cases: Case[] };
  let cases = doc.cases ?? [];
  const stack = arg("stack");
  const id = arg("id");
  if (stack) cases = cases.filter((c) => c.stack === stack);
  if (id) cases = cases.filter((c) => c.id === id);
  const label = arg("label");
  if (label) cases = cases.filter((c) => c.label === label);
  const limit = arg("limit");
  if (limit) cases = cases.slice(0, Number(limit));
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
      const diff = execFileSync("gh", ["pr", "diff", String(c.pr), "--repo", c.repo], {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      });
      writeFileSync(p, diff);
      console.log(`  froze  ${c.id}  (${diff.length} chars)`);
    } catch (e) {
      console.log(`  FAIL   ${c.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const cases = loadCases();

  if (flag("freeze")) {
    console.log(`freezing ${cases.length} case diff(s)…`);
    freeze(cases);
    return;
  }

  const provider = arg("provider") ?? "openrouter";
  const model = arg("model") ?? process.env.SW_MODEL ?? "deepseek/deepseek-v3.2";
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
        provider: structArg.slice(0, structArg.indexOf(":")),
        model: structArg.slice(structArg.indexOf(":") + 1),
        thinking: "off" as ThinkingLevel,
      }
    : undefined;
  const worker = createPiWorker({ apiKeys: keys, structurerLane });
  const verifier = doVerify ? createVerifier({ apiKeys: keys }) : undefined;
  const lane = { id: "eval", provider, model, thinking };

  // real-spend guard: default structurer is OpenRouter (qwen3-coder), so any run touches OR unless overridden to z.ai
  const usesOR = provider === "openrouter" || (structurerLane ? structurerLane.provider === "openrouter" : true);

  // guardrail: refuse OpenRouter reasoning models that can't run cheap at low effort (they fall back to
  // expensive reasoning). Skipped if you explicitly ask for high/xhigh reasoning or pass --allow-reasoning-burn.
  if (provider === "openrouter" && thinking !== "high" && thinking !== "xhigh" && !flag("allow-reasoning-burn")) {
    const risk = openrouterReasoningRisk(model);
    if (risk.block) {
      console.error(
        `\n✋ ABORT: ${model} — ${risk.detail}.\n` +
          `   At low/off effort it still bills expensive reasoning tokens (minimax burned ~$4.8; deepseek-v4-flash ~$0.96/run).\n` +
          `   Use a model whose reasoning disables cheaply (deepseek-v3.2, xiaomi/mimo-v2.5, qwen3.5-flash, or a non-reasoning model),\n` +
          `   or run it intentionally with --thinking high, or pass --allow-reasoning-burn.\n`,
      );
      process.exit(2);
    }
  }

  const creditsBefore = usesOR ? openrouterCredits() : null;

  const missing = cases.filter((c) => !existsSync(diffPath(c.id)));
  if (missing.length) {
    console.error(`Missing frozen diffs for: ${missing.map((c) => c.id).join(", ")}. Run --freeze first.`);
    process.exit(1);
  }

  const structDesc = structurerLane ? `${structurerLane.provider}/${structurerLane.model}` : "openrouter/qwen3-coder-30b";
  console.log(
    `\n▸ eval  model=${provider}/${model}  structurer=${structDesc}  personas=${doPersonas}  thinking=${thinkingSet ? thinking : "per-persona"}  ground=${doGround}  verify=${doVerify}  cases=${cases.length}  conc=${concurrency}`,
  );
  if (creditsBefore !== null) console.log(`  OpenRouter credits before: $${creditsBefore.toFixed(4)}`);
  console.log();

  const results = await pool(cases, concurrency, async (c) => {
    const diff = readFileSync(diffPath(c.id), "utf8").slice(0, 60_000);
    const context: ReviewContext = {
      repo: c.repo,
      prNumber: c.pr,
      baseSha: "",
      headSha: "",
      title: `${c.repo}#${c.pr}`,
      body: "",
      files: splitUnifiedDiff(diff),
    };
    const repoReader = doGround ? ghRepoReader(c.repo, c.pr) : undefined;
    const t0 = Date.now();
    let findings: Finding[];
    let workerCost = 0;
    let noSubmit = 0; // passes where the model never called submit_findings (NOT a clean review — a dropped submission)
    if (doPersonas) {
      const selected = selectPersonas(DEFAULT_PERSONAS, context.files, { cap: 4 });
      const passes = buildPasses(selected);
      const all: Finding[] = [];
      for (const pass of passes) {
        const passLane = { ...lane, thinking: thinkingSet ? thinking : pass.thinking };
        const pr = await worker.run({ context, systemPrompt: pass.prompt, persona: pass.id, lane: passLane, repoReader });
        all.push(...pr.findings);
        workerCost += pr.usage?.costUsd ?? 0;
        if (!pr.usage?.submitted) noSubmit++;
      }
      findings = aggregateFindings(all);
    } else {
      const pr = await worker.run({ context, systemPrompt: PERSONA, persona: "persona:general", lane, repoReader });
      findings = pr.findings;
      workerCost += pr.usage?.costUsd ?? 0;
      if (!pr.usage?.submitted) noSubmit++;
    }
    let confirmed = findings.length;
    let verifyCost = 0;
    if (verifier) {
      confirmed = 0;
      for (const f of findings) {
        const v = await verifier.verify(f, context, lane);
        verifyCost += v.usage?.costUsd ?? 0;
        if (v.verdict === "confirmed") confirmed += 1;
      }
    }
    const ms = Date.now() - t0;
    // has-issue recall: a finding on the same file as an expected locus counts as a hit (boundary-safe;
    // NOTE this is file-level only — it cannot see root-cause/precision; a judge scorer is the real fix).
    const sameFile = (fp: string, lp: string) =>
      fp === lp || fp.endsWith("/" + lp) || lp.endsWith("/" + fp) || fp.split("/").pop() === lp.split("/").pop();
    const lociTotal = c.expect_loci?.length ?? 0;
    const hitLoci = c.expect_loci?.filter((l) => findings.some((f) => sameFile(f.path, l.path))).length ?? 0;
    const line = `[${c.label === "clean" ? "clean    " : "has-issue"}] ${c.id.padEnd(28)} raw=${findings.length} ${
      verifier ? `confirmed=${confirmed} ` : ""
    }${lociTotal ? `hits=${hitLoci}/${lociTotal} ` : ""}${noSubmit ? `nosub=${noSubmit} ` : ""}$${(workerCost + verifyCost).toFixed(4)} ${(ms / 1000).toFixed(0)}s`;
    console.log(line);
    return {
      id: c.id,
      stack: c.stack,
      label: c.label,
      rawFindings: findings.length,
      confirmed,
      hitLoci,
      lociTotal,
      noSubmit,
      costUsd: workerCost + verifyCost,
      ms,
      findings: findings.map((f) => ({ path: f.path, line: f.line, severity: f.severity, message: f.message })),
    };
  });

  // aggregate
  const clean = results.filter((r) => r.label === "clean");
  const issue = results.filter((r) => r.label === "has-issue");
  const cleanFP = clean.reduce((s, r) => s + (doVerify ? r.confirmed : r.rawFindings), 0);
  const issueHits = issue.reduce((s, r) => s + r.hitLoci, 0);
  const issueTotal = issue.reduce((s, r) => s + r.lociTotal, 0);
  const cost = results.reduce((s, r) => s + r.costUsd, 0);
  const secs = results.reduce((s, r) => s + r.ms, 0) / 1000;

  const totalNoSubmit = results.reduce((s, r) => s + (r.noSubmit ?? 0), 0);
  const config = { provider, model, personas: doPersonas, thinking: thinkingSet ? thinking : "per-persona", ground: doGround, verify: doVerify };

  console.log(`\n── ${provider}/${model} ──`);
  console.log(`  clean cases: ${clean.length}  ·  false positives (${doVerify ? "post-verify" : "raw"}): ${cleanFP}`);
  console.log(`  has-issue cases: ${issue.length}  ·  locus recall: ${issueHits}/${issueTotal}`);
  if (totalNoSubmit) console.log(`  ⚠ dropped submissions (model never called submit_findings): ${totalNoSubmit}`);
  console.log(`  reported cost (undercounts reasoning): $${cost.toFixed(4)}  ·  total model-time: ${secs.toFixed(0)}s`);
  const creditsAfter = usesOR ? openrouterCredits() : null;
  const realCost = creditsBefore !== null && creditsAfter !== null ? creditsBefore - creditsAfter : null;
  if (realCost !== null) console.log(`  💳 REAL OpenRouter spend: $${realCost.toFixed(4)}  ·  remaining: $${creditsAfter!.toFixed(4)}`);

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `${REPORT_DIR}/${model.replace(/\//g, "_")}-${stamp}.json`;
  writeFileSync(
    reportPath,
    JSON.stringify({ config, cleanFP, issueHits, issueTotal, totalNoSubmit, cost, results }, null, 2),
  );
  // durable, committed run log (one line per run) for cost/quality tracking across configs/models
  appendFileSync(
    `${ROOT}eval/runs.jsonl`,
    JSON.stringify({
      stamp,
      ...config,
      cleanCases: clean.length,
      cleanFP,
      issueCases: issue.length,
      issueHits,
      issueTotal,
      totalNoSubmit,
      reportedCost: Number(cost.toFixed(4)),
      realCostUsd: realCost !== null ? Number(realCost.toFixed(4)) : null,
      modelSeconds: Number(secs.toFixed(0)),
    }) + "\n",
  );
  console.log(`\n  report: ${reportPath}  ·  logged to eval/runs.jsonl\n`);
}

main().catch((e) => {
  console.error("eval failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
