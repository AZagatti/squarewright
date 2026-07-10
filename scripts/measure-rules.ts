/**
 * Rules measurement (ADR-0005 §1; Hard Rule #5). Runs the REAL product review path
 * (`cli.ts review` → `runReview` → `fsRepoReader` → rule injection) over `eval/rules-fixture` in two arms —
 * rule ON vs rule OFF — N times each, and reports how often the reviewer flags the injected rule-violation.
 *
 * The fixture uses a MADE-UP rule (`Date.now()` → a fictional `clock.ts`) and a FAKE repo name, so the reviewer
 * cannot know the convention from training — an OFF hit would be a genuine miss-attribution, not the rule. The
 * "flagged?" decision is the deterministic `detectRuleFinding` (unit-tested), so the reviewer run is the only
 * variable. Run: `RUNS=5 bun run scripts/measure-rules.ts` (needs a z.ai key in $ZAI_API_KEY or ~/.zai_key).
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRuleFinding,
  type RuleTarget,
  toProbeFindings,
} from "../src/eval/rules-probe.js";

const ROOT = process.cwd();
const FIXTURE = join(ROOT, "eval/rules-fixture");
const ARTIFACT = join(FIXTURE, "artifact");
const RUNS = Number(process.env.RUNS ?? "5");

const ruleTarget = JSON.parse(
  readFileSync(join(FIXTURE, "target.json"), "utf8")
) as RuleTarget;
const inclusiveTarget = JSON.parse(
  readFileSync(join(FIXTURE, "target-inclusive.json"), "utf8")
) as RuleTarget;
const zaiKey = (
  process.env.ZAI_API_KEY ?? readFileSync(join(homedir(), ".zai_key"), "utf8")
).trim();

/** A temp repo root the CLI's `-C` points at: `.squarewright.yml` always, `.review-rules/` only in the ON arm. */
function armDir(withRule: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-rulesmeasure-"));
  copyFileSync(join(ROOT, ".squarewright.yml"), join(dir, ".squarewright.yml"));
  if (withRule) {
    mkdirSync(join(dir, ".review-rules"));
    copyFileSync(
      join(FIXTURE, "rules/clock.md"),
      join(dir, ".review-rules/clock.md")
    );
  }
  return dir;
}

/** One review → both detectors (rule-specific convention citation, and any generic Date.now mention). */
function runOnce(armCwd: string): {
  inclusive: boolean;
  ruleSpecific: boolean;
} {
  const out = execFileSync(
    "bun",
    [
      "run",
      "src/cli.ts",
      "review",
      "--phase",
      "post",
      "--input",
      ARTIFACT,
      "-C",
      armCwd,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ZAI_API_KEY: zaiKey },
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  const findings = toProbeFindings(JSON.parse(out));
  return {
    inclusive: detectRuleFinding(findings, inclusiveTarget),
    ruleSpecific: detectRuleFinding(findings, ruleTarget),
  };
}

function measure(withRule: boolean): {
  inclusive: number;
  ruleSpecific: number;
} {
  const dir = armDir(withRule);
  const label = withRule ? "ON " : "OFF";
  const tally = { inclusive: 0, ruleSpecific: 0 };
  try {
    for (let i = 0; i < RUNS; i += 1) {
      const hit = runOnce(dir);
      tally.ruleSpecific += hit.ruleSpecific ? 1 : 0;
      tally.inclusive += hit.inclusive ? 1 : 0;
      process.stderr.write(
        `  rule ${label} run ${i + 1}/${RUNS}: rule-specific=${hit.ruleSpecific ? "Y" : "n"} inclusive=${hit.inclusive ? "Y" : "n"}\n`
      );
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
  return tally;
}

process.stderr.write(
  `Rules measurement — ${RUNS} runs/arm, made-up clock rule, fake repo (acme/widget)\n`
);
const on = measure(true);
const off = measure(false);
process.stdout.write(
  `\nRESULT (flagged / ${RUNS}):\n` +
    `  rule-specific (cites clock.ts/replay): ON ${on.ruleSpecific} · OFF ${off.ruleSpecific}\n` +
    `  inclusive (any Date.now flag):         ON ${on.inclusive} · OFF ${off.inclusive}\n`
);
