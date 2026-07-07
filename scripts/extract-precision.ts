/**
 * Extract precision-judging input from a saved eval report: every finding (clean AND has-issue cases) +
 * the frozen diff — but deliberately NOT the ground-truth loci/evidence. A precision judge that sees the
 * known bug would pattern-match against it; precision must be graded on each finding's own merits.
 *
 *   bun run scripts/extract-precision.ts eval/reports/<file>.json <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const MAX_DIFF = 12_000;

const report = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
  results: Array<{
    id: string;
    stack: string;
    label: string;
    findings?: Array<{ path: string; line: number; message: string }>;
  }>;
};

const out = report.results
  .filter((r) => (r.findings?.length ?? 0) > 0)
  .map((r) => {
    let diff = "";
    try {
      diff = readFileSync(
        `${ROOT}eval/golden/diffs/${r.id}.diff`,
        "utf8"
      ).slice(0, MAX_DIFF);
    } catch {
      /* diff missing */
    }
    return {
      diff,
      findings: (r.findings ?? []).map((f) => ({
        line: f.line,
        message: f.message,
        path: f.path,
      })),
      id: r.id,
      stack: r.stack,
    };
  });

writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
const totalFindings = out.reduce((s, c) => s + c.findings.length, 0);
console.log(
  `${out.length} cases with findings, ${totalFindings} findings total (no loci included)`
);
