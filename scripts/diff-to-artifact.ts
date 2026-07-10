/**
 * Convert a committed golden unified diff (`eval/golden/diffs/<id>.diff`) into a gather artifact
 * (`pr-files.json` + `pr-meta.json`) so the REAL product review path (`cli.ts review`) can run over a real PR —
 * the input measurements like `scripts/measure-rules.ts` need for a golden-PR rules probe.
 *
 * Usage: `bun run scripts/diff-to-artifact.ts <id> <out-dir> [repo] [title]`
 * The per-file `patch` is the GitHub "list PR files" shape: the hunks only (from the first `@@`), without the
 * `diff --git`/`index`/`---`/`+++` headers.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , id, outDir, repo = "acme/golden", title = "golden PR"] =
  process.argv;
if (!(id && outDir)) {
  process.stderr.write(
    "usage: bun run scripts/diff-to-artifact.ts <id> <out-dir> [repo] [title]\n"
  );
  process.exit(2);
}

const raw = readFileSync(`eval/golden/diffs/${id}.diff`, "utf8");

interface GhFile {
  filename: string;
  patch: string;
  status: "added" | "modified" | "removed";
}

function statusOf(block: string): GhFile["status"] {
  if (block.includes("new file mode")) {
    return "added";
  }
  if (block.includes("deleted file mode")) {
    return "removed";
  }
  return "modified";
}

const files: GhFile[] = [];
// Split into per-file blocks on the "diff --git" marker (keep the marker with each block).
const blocks = raw.split(/^diff --git /m).filter((b) => b.trim());
for (const block of blocks) {
  // "a/path b/path" on the first line → take the b/ path as the filename.
  const header = block.split("\n", 1)[0] ?? "";
  const bMatch = / b\/(.+)$/.exec(` ${header}`);
  const filename = bMatch?.[1]?.trim() ?? header.trim();
  const status = statusOf(block);
  const at = block.indexOf("\n@@");
  const patch = at >= 0 ? block.slice(at + 1) : "";
  if (patch) {
    files.push({ filename, patch, status });
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "pr-files.json"),
  `${JSON.stringify(files, null, 2)}\n`
);
writeFileSync(
  join(outDir, "pr-meta.json"),
  `${JSON.stringify({ base_sha: "base", body: "", head_sha: "head", number: 1, repo, title }, null, 2)}\n`
);
process.stderr.write(
  `Wrote ${files.length} file(s) to ${outDir} (${files.map((f) => f.filename).join(", ")})\n`
);
