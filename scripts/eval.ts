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
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { splitUnifiedDiff } from "../src/core/diff.js";
import type {
  Finding,
  Persona,
  ReviewContext,
  ThinkingLevel,
} from "../src/core/types.js";
import { analysisMentionsLocus, sameFile } from "../src/eval/locus-match.js";
import { aggregateFindings } from "../src/output/aggregate.js";
import { buildPasses, DEFAULT_PERSONAS } from "../src/personas/defaults.js";
import { selectPersonas } from "../src/personas/routing.js";
import type { RepoReader } from "../src/pi/session.js";
import { createVerifier } from "../src/pi/verifier.js";
import { createPiWorker } from "../src/pi/worker.js";
import { renderReviewRules } from "../src/rules/review-rules.js";
import {
  estimatePassSpend,
  openrouterPrice,
  openrouterReasoningRisk,
  parseMaxSpend,
} from "../src/safety/spend-guard.js";
import { formatRange, summarize } from "./lib/variance.js";

/** The headline metrics of one full eval pass, aggregated across repeats into ranges. */
interface RunSummary {
  cleanFP: number;
  cost: number;
  issueHits: number;
  issueTotal: number;
}

const PERSONA = `You are a careful senior code reviewer reviewing a single pull request.
Review ONLY the changes in the diff. Flag correctness bugs, security issues, and clear regressions.
Ground every finding in the diff — do not speculate about code you cannot see. Prefer a few high-signal
findings over many nits. If the change looks fine, submit an empty findings array.`;

const ROOT = new URL("..", import.meta.url).pathname;
// --manifest <path> selects the corpus (default: the golden set); the frozen diffs live in a `diffs/` sibling of
// the manifest, so a second corpus (e.g. eval/contam-safe/) is fully self-contained. Reports always pool together.
const MANIFEST_PATH = arg("manifest") ?? `${ROOT}eval/golden/manifest.yaml`;
const DIFF_DIR = join(dirname(MANIFEST_PATH), "diffs");
const REPORT_DIR = `${ROOT}eval/reports`;
/** Strip a leading YAML frontmatter block from a `.review-rules` file, matching loadReviewRules. */
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;

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
  const doc = parseYaml(readFileSync(MANIFEST_PATH, "utf8")) as {
    cases: Case[];
  };
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
  // --batching split|current|batched — how the selected personas are grouped into Worker calls.
  //   split   = every persona its own call (max fragmentation)
  //   current = correctness+security batched, domain lenses solo (matches the shipped default routing)
  //   batched = ALL fired personas in ONE call (trimwire's winner — tests whether one coherent review wins)
  // Independent of DEFAULT_PERSONAS' own solo/pass fields so the 3 modes are a clean apples-to-apples control.
  const batching = (arg("batching") ?? "current") as
    | "split"
    | "current"
    | "batched";
  // --samples N: run each persona pass N times and union the findings (self-consistency). Recovers catches the
  // model reaches only intermittently (the miss-class map: most misses are "reachable but rare"). --consensus K:
  // after unioning, keep only findings that recurred in ≥K samples — the precision dial on the recall gain.
  const samples = Math.max(1, Math.trunc(Number(arg("samples") ?? 1)));
  const consensus = Math.max(1, Math.trunc(Number(arg("consensus") ?? 1)));
  const CONVERGENT_CORE = new Set(["sentinel", "warden"]);
  const applyBatching = (ps: Persona[]): Persona[] => {
    const base = ps.map((p) => ({ ...p, pass: undefined, solo: undefined }));
    if (batching === "split") {
      return base.map((p) => ({ ...p, solo: true }));
    }
    if (batching === "batched") {
      return base.map((p) => ({ ...p, pass: "all" }));
    }
    // current: convergent core batched (non-solo → "baseline"); every domain lens solo
    return base.map((p) =>
      CONVERGENT_CORE.has(p.id) ? p : { ...p, solo: true }
    );
  };
  const thinkingSet = arg("thinking") !== undefined;
  const concurrency = Number(arg("concurrency") ?? 3);
  const keys = readKeys();
  // Pass-2 structurer override (default is free zai:glm-5-turbo), e.g. --structurer openrouter:qwen/qwen3-coder-30b-a3b-instruct for a paid OR structurer
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

  // real-spend guard: a run touches OpenRouter (and needs the credits check) only if the analysis model OR an
  // explicitly-overridden structurer is on OpenRouter. The default structurer is now free z.ai glm-5-turbo.
  const usesOR =
    provider === "openrouter" || structurerLane?.provider === "openrouter";

  // guardrail: refuse OpenRouter reasoning-trap models (fall back to expensive reasoning at low effort). Checks
  // BOTH the analysis lane AND the structurer lane — a trap *structurer* once burned ~$5 (qwen), and the
  // metadata preflight used to guard only the analysis model. Skipped for high/xhigh or --allow-reasoning-burn.
  if (
    thinking !== "high" &&
    thinking !== "xhigh" &&
    !flag("allow-reasoning-burn")
  ) {
    const orLanes: { model: string; role: string }[] = [];
    if (provider === "openrouter") {
      orLanes.push({ model, role: "analysis" });
    }
    if (structurerLane?.provider === "openrouter") {
      orLanes.push({ model: structurerLane.model, role: "structurer" });
    }
    for (const orLane of orLanes) {
      const risk = openrouterReasoningRisk(orLane.model);
      if (risk.block) {
        console.error(
          `\n✋ ABORT: ${orLane.role} model ${orLane.model} — ${risk.detail}.\n` +
            "   At low/off effort it still bills expensive reasoning tokens (minimax burned ~$4.8; deepseek-v4-flash ~$0.96/run; a trap *structurer* once burned ~$5).\n" +
            "   Use a model whose reasoning disables cheaply (deepseek-v3.2, xiaomi/mimo-v2.5, qwen3.5-flash, or a non-reasoning model),\n" +
            "   or run it intentionally with --thinking high, or pass --allow-reasoning-burn.\n"
        );
        process.exit(2);
      }
    }
  }

  // REAL-TIME SPEND CIRCUIT BREAKER — the only reliable protection. Metadata (mandatory/efforts) missed
  // mimo-v2.5, which looked safe but force-reasoned and burned ~$6.6. This checks actual OR credits during
  // the run and aborts the moment this run's spend exceeds --max-spend (default $0.50).
  const maxSpend = parseMaxSpend(arg("max-spend"), 0.5);
  const analysisPrice =
    provider === "openrouter" ? openrouterPrice(model) : { in: 0, out: 0 };
  const structModelId = structurerLane?.model ?? "glm-5-turbo";
  const structPrice =
    (structurerLane?.provider ?? "zai") === "openrouter"
      ? openrouterPrice(structModelId)
      : { in: 0, out: 0 };
  /** immediate $ estimate from a worker call's token usage (no credit-endpoint lag) */
  const passSpend = (u?: {
    analysisTokens?: { input: number; output: number };
    structTokens?: { input: number; output: number };
  }) => estimatePassSpend(u, analysisPrice, structPrice);
  let localSpend = 0;
  let aborted = false;
  let errored = 0;
  // --note "<text>": prepend an instruction to every analysis system prompt (e.g. steer a reasoning-heavy model
  // to think less). Applies to whatever model this run uses; note it is a DELIBERATE bias when comparing runs.
  const note = arg("note") ?? "";
  const withNote = (prompt: string) => (note ? `${note}\n\n${prompt}` : prompt);
  // --rules <path>: inject a `.review-rules` file as the trusted preamble (faithful to runReview's rule loading)
  // so precision cost of loading rules can be measured (#73). --rule-drift: enable rule-drift emission (§2), which
  // runReview gates on rules being present — so it's only meaningful together with --rules.
  const rulesPath = arg("rules");
  const rulesPreamble = rulesPath
    ? renderReviewRules([
        {
          // strip YAML frontmatter the way loadReviewRules does, so only the rule body is injected
          body: readFileSync(rulesPath, "utf8").replace(FRONTMATTER_RE, ""),
          globs: [],
          path: rulesPath,
        },
      ])
    : "";
  const proposeRuleDrift = flag("rule-drift");
  // --surveyor: SURVEYOR coverage pass (recall lever #45) — measure recall/precision with the flag on vs off.
  const surveyor = flag("surveyor");
  // --cot-scaffold: prompted CoT scaffold (explain → find → self-critique) — A/B recall+precision lever (2026-07-12).
  const doScaffold = flag("cot-scaffold");
  // --divergence: consistency/divergence note (EVAL-ONLY settling experiment, 2026-07-13 council) — diff-scoped,
  // security/correctness-only, citation-forced. Measures whether flagging pattern-divergence FP-floods on the free model.
  const doDivergence = flag("divergence");
  // --analysis-recall: ALSO score loci against the raw pass-1 analysis prose (bypassing the structurer), so the
  // report separates the analysis model's reachability from the structurer's extraction drop (the #78 confound).
  // `analysisRecall − structuredRecall` = loci a capable analysis surfaced but the structurer dropped.
  const doAnalysisRecall = flag("analysis-recall");
  const withContext = (prompt: string) => rulesPreamble + withNote(prompt);
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
    : "zai/glm-5-turbo";
  console.log(
    `\n▸ eval  model=${provider}/${model}  structurer=${structDesc}  personas=${doPersonas}${doPersonas ? ` batching=${batching}` : ""}${samples > 1 ? ` samples=${samples}${consensus > 1 ? `/consensus≥${consensus}` : ""}` : ""}  thinking=${thinkingSet ? thinking : "per-persona"}  ground=${doGround}  verify=${doVerify}  cot-scaffold=${doScaffold}  divergence=${doDivergence}  analysis-recall=${doAnalysisRecall}  cases=${cases.length}  conc=${concurrency}`
  );

  // One full pass over the corpus. Repeated N times (--repeat) through the SHARED spend guard, so the cap holds
  // across repeats and per-run reports/runs.jsonl accumulate the replicates the honest-measurement rule needs.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: behavior-preserving extraction of the existing single-run body
  async function runOnce(): Promise<RunSummary | null> {
    if (aborted) {
      return null;
    }
    const creditsBefore = usesOR ? openrouterCredits() : null;
    if (creditsBefore !== null) {
      console.log(`  OpenRouter credits before: $${creditsBefore.toFixed(4)}`);
    }
    console.log();
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the per-case review+verify+score body, unchanged
    const rawResults = await pool(cases, concurrency, async (c) => {
      spendGuard();
      if (aborted) {
        return null;
      }
      try {
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
        // raw pass-1 prose across every pass/sample — unioned like the structured findings are, so
        // analysis-level recall is measured on the same evidence the structured recall sees (--analysis-recall).
        const analysisTexts: string[] = [];
        let workerCost = 0;
        let noSubmit = 0; // passes where the model never called submit_findings (NOT a clean review — a dropped submission)
        if (doPersonas) {
          const selected = applyBatching(
            selectPersonas(DEFAULT_PERSONAS, context.files, {
              cap: 4,
            })
          );
          const passes = buildPasses(selected);
          const all: Finding[] = [];
          for (const pass of passes) {
            const passLane = {
              ...lane,
              thinking: thinkingSet ? thinking : pass.thinking,
            };
            for (let s = 0; s < samples; s += 1) {
              // biome-ignore lint/performance/noAwaitInLoops: sequential by design — each run feeds the local spend guard (spendGuard/aborted) checked right after, so later runs must know the running spend before firing
              const pr = await worker.run({
                context,
                cotScaffold: doScaffold,
                divergence: doDivergence,
                lane: passLane,
                persona: pass.id,
                proposeRuleDrift,
                repoReader,
                surveyor,
                systemPrompt: withContext(pass.prompt),
              });
              all.push(...pr.findings);
              if (pr.usage?.analysisText) {
                analysisTexts.push(pr.usage.analysisText);
              }
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
            if (aborted) {
              break;
            }
          }
          // union across samples, then (optionally) keep only findings that recurred in ≥`consensus` samples
          const aggregated = aggregateFindings(all);
          findings =
            consensus > 1
              ? aggregated.filter((f) => f.consensus >= consensus)
              : aggregated;
        } else {
          const pr = await worker.run({
            context,
            cotScaffold: doScaffold,
            divergence: doDivergence,
            lane,
            persona: "persona:general",
            proposeRuleDrift,
            repoReader,
            surveyor,
            systemPrompt: withContext(PERSONA),
          });
          ({ findings } = pr);
          if (pr.usage?.analysisText) {
            analysisTexts.push(pr.usage.analysisText);
          }
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
        // `sameFile` is shared with the miss-map so both score loci by one definition (src/eval/locus-match.ts).
        const lociTotal = c.expect_loci?.length ?? 0;
        // Score every locus once on BOTH axes — structured (a pass-2 finding landed on the file) and analysis
        // (--analysis-recall: the raw pass-1 prose named the file). Both reuse `sameFile`, so the two axes differ
        // only in WHICH text they scan, not in the match rule (no metric drift).
        const analysisProse = analysisTexts.join("\n");
        const lociScored = (c.expect_loci ?? []).map((l) => ({
          analysis:
            doAnalysisRecall && analysisMentionsLocus(analysisProse, l.path),
          structured: findings.some((f) => sameFile(f.path, l.path)),
        }));
        const hitLoci = lociScored.filter((x) => x.structured).length;
        const hitLociAnalysis = lociScored.filter((x) => x.analysis).length;
        // Decompose the two axes PER LOCUS rather than subtracting totals — `ahits ≥ hits` is not an invariant
        // (the structurer can synthesize a locus-matching path from a vague description the prose never literally
        // names), so a scalar `ahits − hits` could go negative and mislead. drop = the real #78 confound (analysis
        // surfaced it, structurer dropped it); synth = structurer landed on a locus the prose never named, so a
        // nonzero synth means analysis-recall UNDERcounts and `drop` is a floor.
        const dropLoci = lociScored.filter(
          (x) => x.analysis && !x.structured
        ).length;
        const synthLoci = doAnalysisRecall
          ? lociScored.filter((x) => x.structured && !x.analysis).length
          : 0;
        const line = `[${c.label === "clean" ? "clean    " : "has-issue"}] ${c.id.padEnd(28)} raw=${findings.length} ${
          verifier ? `confirmed=${confirmed} ` : ""
        }${lociTotal ? `hits=${hitLoci}/${lociTotal} ` : ""}${doAnalysisRecall && lociTotal ? `ahits=${hitLociAnalysis}/${lociTotal} ` : ""}${noSubmit ? `nosub=${noSubmit} ` : ""}$${(workerCost + verifyCost).toFixed(4)} ${(ms / 1000).toFixed(0)}s`;
        console.log(line);
        return {
          confirmed,
          costUsd: workerCost + verifyCost,
          dropLoci,
          findings: findings.map((f) => ({
            line: f.line,
            message: f.message,
            path: f.path,
            severity: f.severity,
          })),
          hitLoci,
          hitLociAnalysis,
          id: c.id,
          label: c.label,
          lociTotal,
          ms,
          noSubmit,
          rawFindings: findings.length,
          stack: c.stack,
          synthLoci,
        };
      } catch (e) {
        // Isolate a per-case failure (e.g. a provider 429 once quota is exhausted) so it can't reject the whole
        // pool and lose every completed case. Drop it (returns null → excluded from metrics, never a fake 0),
        // exactly like a circuit-breaker skip; the run still finishes and writes a report for the cases that ran.
        errored += 1;
        console.log(
          `  ERROR  ${c.id}: ${e instanceof Error ? e.message : String(e)}`
        );
        return null;
      }
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
    if (errored > 0) {
      console.log(
        `  ⚠️  ${errored} case(s) errored (e.g. provider quota) and were excluded — report covers the ${results.length} that ran`
      );
    }
    const clean = results.filter((r) => r.label === "clean");
    const issue = results.filter((r) => r.label === "has-issue");
    const cleanFP = clean.reduce(
      (s, r) => s + (doVerify ? r.confirmed : r.rawFindings),
      0
    );
    const issueHits = issue.reduce((s, r) => s + r.hitLoci, 0);
    const issueHitsAnalysis = issue.reduce((s, r) => s + r.hitLociAnalysis, 0);
    const issueDrop = issue.reduce((s, r) => s + r.dropLoci, 0);
    const issueSynth = issue.reduce((s, r) => s + r.synthLoci, 0);
    const issueTotal = issue.reduce((s, r) => s + r.lociTotal, 0);
    const cost = results.reduce((s, r) => s + r.costUsd, 0);
    const secs = results.reduce((s, r) => s + r.ms, 0) / 1000;

    const totalNoSubmit = results.reduce((s, r) => s + (r.noSubmit ?? 0), 0);
    const config = {
      // analysis-recall mode is part of what's measured — persist it so the pre-structurer recall column in a
      // report is distinguishable from a plain run (where issueHitsAnalysis is 0 because the mode was off).
      analysisRecall: doAnalysisRecall || undefined,
      // batching mode is part of what's measured — persist it so split/current/batched runs are
      // distinguishable in the durable log (runs.jsonl), not just in someone's terminal scrollback.
      batching: doPersonas ? batching : undefined,
      consensus: doPersonas && samples > 1 ? consensus : undefined,
      // scaffold (prompted CoT) changes the analysis prose — persist it so scaffold-on vs -off arms are
      // auditable from the durable log, not reconstructed from run-order/cleanFP heuristics (the gap the
      // scaffold council flagged as a reproducibility blocker). Mirrors eval-cli.ts's config.cotScaffold.
      cotScaffold: doScaffold,
      // divergence note persisted alongside the other analysis-prose levers so its on/off arms are auditable
      // from the durable log (eval-only settling experiment, 2026-07-13 council).
      divergence: doDivergence,
      ground: doGround,
      model,
      personas: doPersonas,
      provider,
      samples: doPersonas ? samples : undefined,
      // the structurer (pass 2) is part of what's measured — a weak structurer silently drops findings from a
      // capable analysis model (the nosub bug), so a rank is only auditable if the report records which one ran.
      structurer: structurerLane
        ? `${structurerLane.provider}/${structurerLane.model}`
        : "zai/glm-5-turbo",
      // surveyor persisted alongside cotScaffold so a scaffold×surveyor interaction run's arms are auditable
      // from the durable log, not reconstructed from run-order.
      surveyor,
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
    if (doAnalysisRecall) {
      console.log(
        `  analysis-level locus recall (pre-structurer): ${issueHitsAnalysis}/${issueTotal}  ·  structurer drop: ${issueDrop} loci the analysis named but no structured finding landed on`
      );
      if (issueSynth > 0) {
        console.log(
          `  ⚠ ${issueSynth} locus/loci had a structured finding but were not named in the prose (structurer paraphrased a path, or the matcher missed the form) — treat the drop as a floor`
        );
      }
    }
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
        {
          cleanFP,
          config,
          cost,
          issueDrop: doAnalysisRecall ? issueDrop : undefined,
          issueHits,
          issueHitsAnalysis: doAnalysisRecall ? issueHitsAnalysis : undefined,
          issueSynth: doAnalysisRecall ? issueSynth : undefined,
          issueTotal,
          results,
          totalNoSubmit,
        },
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
        issueDrop: doAnalysisRecall ? issueDrop : undefined,
        issueHits,
        issueHitsAnalysis: doAnalysisRecall ? issueHitsAnalysis : undefined,
        issueSynth: doAnalysisRecall ? issueSynth : undefined,
        issueTotal,
        modelSeconds: Number(secs.toFixed(0)),
        realCostUsd: realCost === null ? null : Number(realCost.toFixed(4)),
        reportedCost: Number(cost.toFixed(4)),
        totalNoSubmit,
      })}\n`
    );
    console.log(`\n  report: ${reportPath}  ·  logged to eval/runs.jsonl\n`);
    return { cleanFP, cost, issueHits, issueTotal };
  }

  const repeatRaw = arg("repeat");
  const repeat = repeatRaw === undefined ? 1 : Number(repeatRaw);
  if (!Number.isInteger(repeat) || repeat < 1) {
    console.error(`--repeat must be a positive integer (got "${repeatRaw}").`);
    process.exit(1);
  }
  const runs: RunSummary[] = [];
  for (let i = 0; i < repeat; i += 1) {
    if (repeat > 1) {
      console.log(`\n=== run ${i + 1}/${repeat} ===`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: repeats are sequential by design — one shared spend guard caps total spend across runs, and z.ai concurrency ≤5 is respected within each run
    const r = await runOnce();
    if (r) {
      runs.push(r);
    }
    if (aborted) {
      break;
    }
  }

  const [first] = runs;
  if (repeat > 1 && first) {
    const { issueTotal } = first;
    const recall = summarize(runs.map((r) => r.issueHits));
    const fp = summarize(runs.map((r) => r.cleanFP));
    console.log(
      `\n══ ${runs.length}-run summary (ranges, not a point — run-to-run variance is real) ══`
    );
    console.log(`  locus recall: ${formatRange(recall)} / ${issueTotal}`);
    console.log(`  false positives: ${formatRange(fp)}`);
  }
}

main().catch((e) => {
  console.error("eval failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
