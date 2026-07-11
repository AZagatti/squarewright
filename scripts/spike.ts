/**
 * Pi-worker spike — validates the whole direction end-to-end:
 *   real PR diff  ->  Pi (persona + submit_findings tool)  ->  structured findings + cost.
 *
 * Not shipped code; a validation harness for the src/pi/worker.ts keystone.
 *
 * Usage:
 *   bun run scripts/spike.ts --repo <owner/repo> --pr <number>
 *   bun run scripts/spike.ts --diff <path-to.diff>
 *   SW_MODEL=deepseek/deepseek-v3.2 bun run scripts/spike.ts --repo gin-gonic/gin --pr 4003
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { splitUnifiedDiff } from "../src/core/diff.js";
import type { ReviewContext, ThinkingLevel } from "../src/core/types.js";
import { createVerifier } from "../src/pi/verifier.js";
import { createPiWorker } from "../src/pi/worker.js";
import {
  estimatePassSpend,
  makeSpendGuard,
  openrouterPrice,
  openrouterReasoningRisk,
  parseMaxSpend,
} from "../src/safety/spend-guard.js";

const THINKING = (process.env.SW_THINKING ?? "off") as ThinkingLevel;

const PERSONA = `You are a careful senior code reviewer reviewing a single pull request.
Review ONLY the changes in the diff. Flag correctness bugs, security issues, and clear regressions.
Ground every finding in the diff — do not speculate about code you cannot see. Prefer a few high-signal
findings over many nits. If the change looks fine, submit an empty findings array. Be precise about file
paths and line numbers, taken from the diff's +++ headers and hunk markers.`;

const MAX_DIFF_CHARS = 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readKey(): string {
  const env = process.env.OPENROUTER_API_KEY;
  if (env) {
    return env.trim();
  }
  return readFileSync(`${homedir()}/.or_key`, "utf8").trim();
}

function getDiff(): { diff: string; label: string } {
  const diffPath = arg("diff");
  if (diffPath) {
    return { diff: readFileSync(diffPath, "utf8"), label: diffPath };
  }
  const repo = arg("repo");
  const pr = arg("pr");
  if (!(repo && pr)) {
    throw new Error(
      "provide --diff <file> OR --repo <owner/repo> --pr <number>"
    );
  }
  const diff = execFileSync("gh", ["pr", "diff", pr, "--repo", repo], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return { diff, label: `${repo}#${pr}` };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: refactor tracked separately — behavior-preserving change out of scope for the tooling PR
async function main() {
  // No silent paid default: require an explicit model so `spike` can never bill OpenRouter by accident.
  const model = arg("model") ?? process.env.SW_MODEL;
  if (!model) {
    console.error(
      "spike needs an explicit paid model — pass --model <id> or set SW_MODEL (no default, to avoid silent OpenRouter spend)."
    );
    process.exit(1);
  }
  const { diff: rawDiff, label } = getDiff();
  const diff =
    rawDiff.length > MAX_DIFF_CHARS
      ? rawDiff.slice(0, MAX_DIFF_CHARS)
      : rawDiff;
  const truncated = rawDiff.length > MAX_DIFF_CHARS;

  const files = splitUnifiedDiff(diff);
  const context: ReviewContext = {
    baseSha: "",
    body: "",
    files,
    headSha: "",
    prNumber: Number(arg("pr") ?? 0),
    repo: label,
    title: label,
  };

  console.log(`\n▸ spike: ${label}  (model: openrouter/${model})`);
  console.log(
    `  diff: ${rawDiff.length} chars${truncated ? ` (truncated to ${MAX_DIFF_CHARS})` : ""}, ${files.length} file(s)\n`
  );

  // Local spend guard: paid runs are capped by --max-spend (default $0.50). Some reasoning models can't disable
  // reasoning and burn far more than Pi's usage.cost reports, so we estimate from tokens against real prices.
  const maxSpend = parseMaxSpend(arg("max-spend"), 0.5);
  const analysisPrice = openrouterPrice(model);
  const structPrice = openrouterPrice("qwen/qwen3-coder-30b-a3b-instruct");
  const guard = makeSpendGuard(maxSpend);

  // Pre-spend guardrail: refuse a model whose reasoning can't be disabled cheaply (it bills expensive reasoning
  // tokens even at off — the ~$5 trap). The circuit breaker only acts AFTER a pass, so it can't stop a single
  // runaway pass; this pre-check is the real defense. Covers the verify model too. Override --allow-reasoning-burn.
  const verifyRequested = process.argv.includes("--verify");
  const verifyModel = verifyRequested
    ? (process.env.SW_VERIFY_MODEL ?? model)
    : null;
  if (
    THINKING !== "high" &&
    THINKING !== "xhigh" &&
    !process.argv.includes("--allow-reasoning-burn")
  ) {
    const toCheck =
      verifyModel && verifyModel !== model ? [model, verifyModel] : [model];
    for (const mdl of toCheck) {
      const risk = openrouterReasoningRisk(mdl);
      if (risk.block) {
        console.error(
          `\n✋ ABORT: ${mdl} — ${risk.detail}.\n` +
            "   Use a model whose reasoning disables cheaply (e.g. deepseek/deepseek-v3.2), run it with\n" +
            "   --thinking high, or pass --allow-reasoning-burn to override."
        );
        process.exit(2);
      }
    }
  }

  const worker = createPiWorker({ apiKeys: { openrouter: readKey() } });
  const t0 = Date.now();
  const result = await worker.run({
    context,
    lane: { id: "default", model, provider: "openrouter", thinking: THINKING },
    persona: "persona:general",
    systemPrompt: PERSONA,
  });
  const ms = Date.now() - t0;

  console.log(`── summary ──\n${result.usage?.summary ?? "(none)"}\n`);
  console.log(`── ${result.findings.length} finding(s) ──`);
  for (const f of result.findings) {
    console.log(`\n[${f.severity}] ${f.path}:${f.line}  (${f.rule})`);
    console.log(`  ${f.message}`);
    if (f.suggestion) {
      console.log(`  suggestion: ${f.suggestion}`);
    }
  }
  guard.add(estimatePassSpend(result.usage, analysisPrice, structPrice));
  console.log(
    `\n── worker cost/latency ──\n  tool calls: ${result.usage?.toolCalls}  ·  cost: $${(result.usage?.costUsd ?? 0).toFixed(5)}  ·  wall: ${(ms / 1000).toFixed(1)}s`
  );
  console.log(
    `  est. spend (token-based): ~$${guard.spent().toFixed(4)}  ·  cap --max-spend $${maxSpend}${guard.tripped() ? "  🛑 OVER CAP" : ""}`
  );

  if (verifyRequested && verifyModel && result.findings.length > 0) {
    console.log(
      `\n══ adversarial verify (model: openrouter/${verifyModel}) ══`
    );
    const verifier = createVerifier({ apiKeys: { openrouter: readKey() } });
    let confirmed = 0;
    let verifyCost = 0;
    for (const f of result.findings) {
      if (guard.tripped()) {
        console.error(
          `\n🛑 CIRCUIT BREAKER: est. spend ~$${guard.spent().toFixed(4)} > --max-spend $${maxSpend}. Skipping remaining verifies.`
        );
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design — respects the provider's concurrency limits for one-off verify runs
      const v = await verifier.verify(f, context, {
        id: "verify",
        model: verifyModel,
        provider: "openrouter",
        thinking: THINKING,
      });
      verifyCost += v.usage?.costUsd ?? 0;
      // best-effort: the verifier exposes only Pi's costUsd (no tokens), which undercounts reasoning — so the
      // verify-loop cap is looser than the token-based main-pass estimate. The pre-check refusing reasoning
      // models (incl. the verify model above) is what keeps that undercount from mattering.
      guard.add(v.usage?.costUsd ?? 0);
      if (v.verdict === "confirmed") {
        confirmed += 1;
      }
      let mark: string;
      if (v.verdict === "confirmed") {
        mark = "✓ CONFIRMED";
      } else if (v.verdict === "refuted") {
        mark = "✗ REFUTED";
      } else {
        mark = "? UNCERTAIN";
      }
      console.log(`\n${mark}  ${f.path}:${f.line}`);
      console.log(`  ${v.reasoning}`);
      if (v.evidence) {
        console.log(`  evidence: ${v.evidence.replace(/\n/g, "\n  ")}`);
      }
    }
    console.log(
      `\n── after verify ──\n  ${result.findings.length} raw → ${confirmed} confirmed  ·  verify cost: $${verifyCost.toFixed(5)}\n`
    );
  }
}

main().catch((e) => {
  console.error("spike failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
