/**
 * `squarewright init` — scaffolds a working reviewer assembly into a repo. Generated files are THIN and
 * reference the versioned squarewright harness/Action; the heavy logic stays upstream, upgradable (ADR-0001).
 */
import { cp, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

interface CopySpec {
  from: string; // relative to templates/
  to: string; // relative to repo root
}

const SCAFFOLD: CopySpec[] = [
  { from: "workflows/squarewright-gather.yml", to: ".github/workflows/squarewright-gather.yml" },
  { from: "workflows/squarewright-review.yml", to: ".github/workflows/squarewright-review.yml" },
  { from: ".squarewright.yml", to: ".squarewright.yml" },
  { from: "review-rules/README.md", to: ".review-rules/README.md" },
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function scaffold(repoRoot: string): Promise<void> {
  console.log("squarewright init — scaffolding a reviewer assembly\n");
  for (const spec of SCAFFOLD) {
    const dest = join(repoRoot, spec.to);
    if (await exists(dest)) {
      console.log(`  skip (exists)  ${spec.to}`);
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(TEMPLATES_DIR, spec.from), dest);
    console.log(`  created        ${spec.to}`);
  }
  console.log(`
Next steps:
  1. Add a provider API key as a repo secret (e.g. OPENROUTER_API_KEY or ANTHROPIC_API_KEY).
     Settings → Secrets and variables → Actions → New repository secret.
  2. Set the provider + model in .squarewright.yml (lanes).
  3. Open a PR — the Gather workflow runs untrusted (no secrets); the Review workflow runs trusted and posts.

Docs: https://github.com/AZagatti/squarewright/blob/main/docs/ROADMAP.md
Note: the review harness is pre-v0.1 — the scaffolded workflows encode the safe two-phase structure; the
      posting harness they call is still being built.`);
}
