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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { createPiWorker } from "../src/pi/worker.js";
import { createVerifier } from "../src/pi/verifier.js";
import { splitUnifiedDiff } from "../src/core/diff.js";
import type { ReviewContext, ThinkingLevel } from "../src/core/types.js";

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
function readKey(): string {
  return (process.env.OPENROUTER_API_KEY ?? readFileSync(`${homedir()}/.or_key`, "utf8")).trim();
}
function loadCases(): Case[] {
  const doc = parseYaml(readFileSync(`${ROOT}eval/golden/manifest.yaml`, "utf8")) as { cases: Case[] };
  let cases = doc.cases ?? [];
  const stack = arg("stack");
  const id = arg("id");
  if (stack) cases = cases.filter((c) => c.stack === stack);
  if (id) cases = cases.filter((c) => c.id === id);
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

  const model = arg("model") ?? process.env.SW_MODEL ?? "deepseek/deepseek-v3.2";
  const thinking = (arg("thinking") ?? "off") as ThinkingLevel;
  const doVerify = flag("verify");
  const concurrency = Number(arg("concurrency") ?? 3);
  const key = readKey();
  const worker = createPiWorker({ apiKeys: { openrouter: key } });
  const verifier = doVerify ? createVerifier({ apiKeys: { openrouter: key } }) : undefined;
  const lane = { id: "eval", provider: "openrouter", model, thinking };

  const missing = cases.filter((c) => !existsSync(diffPath(c.id)));
  if (missing.length) {
    console.error(`Missing frozen diffs for: ${missing.map((c) => c.id).join(", ")}. Run --freeze first.`);
    process.exit(1);
  }

  console.log(`\n▸ eval  model=openrouter/${model}  thinking=${thinking}  verify=${doVerify}  cases=${cases.length}  concurrency=${concurrency}\n`);

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
    const t0 = Date.now();
    const r = await worker.run({ context, systemPrompt: PERSONA, persona: `persona:general`, lane });
    let confirmed = r.findings.length;
    let verifyCost = 0;
    if (verifier) {
      confirmed = 0;
      for (const f of r.findings) {
        const v = await verifier.verify(f, context, lane);
        verifyCost += v.usage?.costUsd ?? 0;
        if (v.verdict === "confirmed") confirmed += 1;
      }
    }
    const ms = Date.now() - t0;
    // has-issue recall: a finding on the same file (basename) as an expected locus counts as a hit
    const lociTotal = c.expect_loci?.length ?? 0;
    const hitLoci =
      c.expect_loci?.filter((l) =>
        r.findings.some((f) => f.path.endsWith(l.path) || l.path.endsWith(f.path.split("/").pop() ?? "")),
      ).length ?? 0;
    const line = `[${c.label === "clean" ? "clean    " : "has-issue"}] ${c.id.padEnd(28)} raw=${r.findings.length} ${
      verifier ? `confirmed=${confirmed} ` : ""
    }${lociTotal ? `hits=${hitLoci}/${lociTotal} ` : ""}$${((r.usage?.costUsd ?? 0) + verifyCost).toFixed(4)} ${(ms / 1000).toFixed(0)}s`;
    console.log(line);
    return {
      id: c.id,
      stack: c.stack,
      label: c.label,
      rawFindings: r.findings.length,
      confirmed,
      hitLoci,
      lociTotal,
      costUsd: (r.usage?.costUsd ?? 0) + verifyCost,
      ms,
      findings: r.findings.map((f) => ({ path: f.path, line: f.line, severity: f.severity, message: f.message })),
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

  console.log(`\n── ${model} ──`);
  console.log(`  clean cases: ${clean.length}  ·  false positives (${doVerify ? "post-verify" : "raw"}): ${cleanFP}`);
  console.log(`  has-issue cases: ${issue.length}  ·  locus recall: ${issueHits}/${issueTotal}`);
  console.log(`  total cost: $${cost.toFixed(4)}  ·  total model-time: ${secs.toFixed(0)}s`);

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `${REPORT_DIR}/${model.replace(/\//g, "_")}-${stamp}.json`;
  writeFileSync(
    reportPath,
    JSON.stringify({ model, verify: doVerify, cleanFP, issueHits, issueTotal, cost, results }, null, 2),
  );
  console.log(`\n  report: ${reportPath}\n`);
}

main().catch((e) => {
  console.error("eval failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
