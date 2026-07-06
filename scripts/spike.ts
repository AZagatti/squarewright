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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createPiWorker } from "../src/pi/worker.js";
import { createVerifier } from "../src/pi/verifier.js";
import { splitUnifiedDiff } from "../src/core/diff.js";
import type { ReviewContext } from "../src/core/types.js";

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
  if (env) return env.trim();
  return readFileSync(`${homedir()}/.or_key`, "utf8").trim();
}

function getDiff(): { diff: string; label: string } {
  const diffPath = arg("diff");
  if (diffPath) return { diff: readFileSync(diffPath, "utf8"), label: diffPath };
  const repo = arg("repo");
  const pr = arg("pr");
  if (!repo || !pr) throw new Error("provide --diff <file> OR --repo <owner/repo> --pr <number>");
  const diff = execFileSync("gh", ["pr", "diff", pr, "--repo", repo], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  return { diff, label: `${repo}#${pr}` };
}

async function main() {
  const model = process.env.SW_MODEL ?? "anthropic/claude-haiku-4.5";
  const { diff: rawDiff, label } = getDiff();
  const diff = rawDiff.length > MAX_DIFF_CHARS ? rawDiff.slice(0, MAX_DIFF_CHARS) : rawDiff;
  const truncated = rawDiff.length > MAX_DIFF_CHARS;

  const files = splitUnifiedDiff(diff);
  const context: ReviewContext = {
    repo: label,
    prNumber: Number(arg("pr") ?? 0),
    baseSha: "",
    headSha: "",
    title: label,
    body: "",
    files,
  };

  console.log(`\n▸ spike: ${label}  (model: openrouter/${model})`);
  console.log(`  diff: ${rawDiff.length} chars${truncated ? ` (truncated to ${MAX_DIFF_CHARS})` : ""}, ${files.length} file(s)\n`);

  const worker = createPiWorker({ apiKeys: { openrouter: readKey() } });
  const t0 = Date.now();
  const result = await worker.run({
    context,
    systemPrompt: PERSONA,
    persona: "persona:general",
    lane: { id: "default", provider: "openrouter", model },
  });
  const ms = Date.now() - t0;

  console.log(`── summary ──\n${result.usage?.summary ?? "(none)"}\n`);
  console.log(`── ${result.findings.length} finding(s) ──`);
  for (const f of result.findings) {
    console.log(`\n[${f.severity}] ${f.path}:${f.line}  (${f.rule})`);
    console.log(`  ${f.message}`);
    if (f.suggestion) console.log(`  suggestion: ${f.suggestion}`);
  }
  console.log(
    `\n── worker cost/latency ──\n  tool calls: ${result.usage?.toolCalls}  ·  cost: $${(result.usage?.costUsd ?? 0).toFixed(5)}  ·  wall: ${(ms / 1000).toFixed(1)}s`,
  );

  if (process.argv.includes("--verify") && result.findings.length > 0) {
    const verifyModel = process.env.SW_VERIFY_MODEL ?? model;
    console.log(`\n══ adversarial verify (model: openrouter/${verifyModel}) ══`);
    const verifier = createVerifier({ apiKeys: { openrouter: readKey() } });
    let confirmed = 0;
    let verifyCost = 0;
    for (const f of result.findings) {
      const v = await verifier.verify(f, context, { id: "verify", provider: "openrouter", model: verifyModel });
      verifyCost += v.usage?.costUsd ?? 0;
      if (v.verdict === "confirmed") confirmed += 1;
      const mark = v.verdict === "confirmed" ? "✓ CONFIRMED" : v.verdict === "refuted" ? "✗ REFUTED" : "? UNCERTAIN";
      console.log(`\n${mark}  ${f.path}:${f.line}`);
      console.log(`  ${v.reasoning}`);
      if (v.evidence) console.log(`  evidence: ${v.evidence.replace(/\n/g, "\n  ")}`);
    }
    console.log(
      `\n── after verify ──\n  ${result.findings.length} raw → ${confirmed} confirmed  ·  verify cost: $${verifyCost.toFixed(5)}\n`,
    );
  }
}

main().catch((e) => {
  console.error("spike failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
