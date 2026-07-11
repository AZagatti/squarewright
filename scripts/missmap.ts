/**
 * Golden-corpus miss map (issue #45 AC1): per-locus file-level recall across every saved eval report, so the
 * recall bottleneck is a reproducible table instead of a hand-written one. Reads the manifest's has-issue loci
 * and `eval/reports/*.json`, and prints each locus's hit rate — overall and split by config axis (grounded,
 * strong vs weaker analysis model) to hint at whether a miss is model-liftable or a harder ceiling.
 *
 *   bun run scripts/missmap.ts [--manifest eval/golden/manifest.yaml] [--reports-dir eval/reports]
 *
 * File-level only (an upper bound on true defect recall — see src/eval/missmap.ts). "Strong" is a coarse model
 * name match, directional not authoritative.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type GoldenLoci,
  type MissReport,
  perLocusHitRates,
  reportsCoveringGolden,
} from "../src/eval/missmap.js";

const ROOT = new URL("..", import.meta.url).pathname;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// A hand-listed set of models (the free default glm-5.2 plus ones RESULTS.md flags as candidates for beating it).
// This is a NAMED-SET membership test, not a proven strength ordering — the columns are labelled "listed"/"other"
// accordingly. Keep the list in sync with what RESULTS.md's "#45 AC1" section calls out.
const LISTED_MODEL = /fugu|sonnet|deepseek-v4|grok|minimax-m3|glm-5\.2/i;
function isListed(config: Record<string, unknown> | undefined): boolean {
  return LISTED_MODEL.test(String(config?.model ?? ""));
}

function loadGolden(manifestPath: string): GoldenLoci {
  const manifest = parseYaml(readFileSync(manifestPath, "utf8")) as {
    cases: Array<{
      id: string;
      label: string;
      expect_loci?: Array<{ path: string }>;
    }>;
  };
  const golden: GoldenLoci = new Map();
  for (const c of manifest.cases) {
    if (c.label === "has-issue" && c.expect_loci?.length) {
      golden.set(
        c.id,
        c.expect_loci.map((l) => l.path)
      );
    }
  }
  return golden;
}

function loadReports(dir: string): MissReport[] {
  const reports: MissReport[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) {
      continue;
    }
    try {
      reports.push(
        JSON.parse(readFileSync(join(dir, f), "utf8")) as MissReport
      );
    } catch {
      // A malformed/partial report is skipped, not counted — never fabricate coverage from an unreadable file.
    }
  }
  return reports;
}

function pct(hit: number, total: number): string {
  return total === 0
    ? "—".padStart(11)
    : `${(100 * (hit / total)).toFixed(0).padStart(3)}% (${hit}/${total})`;
}

function main(): void {
  const manifestPath = arg("manifest", `${ROOT}eval/golden/manifest.yaml`);
  const reportsDir = arg("reports-dir", `${ROOT}eval/reports`);
  const golden = loadGolden(manifestPath);
  const reports = loadReports(reportsDir);

  const overall = perLocusHitRates(reports, golden);
  const listed = new Map(
    perLocusHitRates(reports, golden, isListed).map((r) => [r.key, r])
  );
  const other = new Map(
    perLocusHitRates(reports, golden, (c) => !isListed(c)).map((r) => [
      r.key,
      r,
    ])
  );

  console.log(
    `\n▸ golden miss map — ${reports.length} reports, ${reportsCoveringGolden(reports, golden)} cover ≥1 golden case\n`
  );
  console.log(
    `${"locus (case#loci)".padEnd(28)} ${"overall".padEnd(13)} ${"listed*".padEnd(13)} ${"other".padEnd(13)} path`
  );
  for (const r of overall) {
    const s = listed.get(r.key);
    const w = other.get(r.key);
    console.log(
      `${r.key.padEnd(28)} ${pct(r.hit, r.total).padEnd(13)} ${pct(s?.hit ?? 0, s?.total ?? 0).padEnd(13)} ${pct(w?.hit ?? 0, w?.total ?? 0).padEnd(13)} ${r.path}`
    );
  }
  console.log(
    `\n* "listed" = model name matches ${LISTED_MODEL.source} (glm-5.2 + named candidates); "other" = the rest. A named-set membership test, NOT a proven strength ordering.`
  );
  console.log(
    "File-level only — an upper bound on true defect recall (the judge measures root-cause matches). See eval/RESULTS.md '#45 AC1'.\n"
  );
}

main();
