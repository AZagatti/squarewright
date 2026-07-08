/**
 * `squarewright init` — scaffolds a working reviewer assembly into a repo. Generated files are THIN and
 * reference the versioned squarewright harness/Action; the heavy logic stays upstream, upgradable (ADR-0001).
 */
import { access, cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDefaultConfig } from "./default-config.js";

const TEMPLATES_DIR = fileURLToPath(
  new URL("../../templates/", import.meta.url)
);

interface CopySpec {
  from: string; // relative to templates/
  to: string; // relative to repo root
}

const SCAFFOLD: CopySpec[] = [
  {
    from: "workflows/squarewright-gather.yml",
    to: ".github/workflows/squarewright-gather.yml",
  },
  {
    from: "workflows/squarewright-review.yml",
    to: ".github/workflows/squarewright-review.yml",
  },
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

/** Write `dest` via `produce` unless it already exists (idempotent); log which happened. */
async function placeFile(
  dest: string,
  label: string,
  produce: () => Promise<void>
): Promise<void> {
  if (await exists(dest)) {
    console.log(`  skip (exists)  ${label}`);
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  await produce();
  console.log(`  created        ${label}`);
}

export async function scaffold(repoRoot: string): Promise<void> {
  console.log("squarewright init — scaffolding a reviewer assembly\n");
  for (const spec of SCAFFOLD) {
    const dest = join(repoRoot, spec.to);
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design — scaffolding places files in declared order, one at a time, to keep console output ordered and deterministic
    await placeFile(dest, spec.to, () =>
      cp(join(TEMPLATES_DIR, spec.from), dest)
    );
  }

  // The config is generated (not copied) so its personas stay in sync with DEFAULT_PERSONAS.
  const configDest = join(repoRoot, ".squarewright.yml");
  await placeFile(configDest, ".squarewright.yml", () =>
    writeFile(configDest, renderDefaultConfig())
  );

  console.log(`
Next steps:
  1. Add a provider API key as a repo secret. The default lanes use z.ai, so add ZAI_API_KEY (free tier works).
     Settings → Secrets and variables → Actions → New repository secret.
  2. (Optional) Retarget lanes in .squarewright.yml — point "strong" at a frontier model, or swap the provider.
  3. Open a PR — the Gather workflow runs untrusted (no secrets); the Review workflow runs trusted and posts.

Docs: https://github.com/AZagatti/squarewright/blob/main/docs/ROADMAP.md
Note: the review harness is pre-v0.1 — the scaffolded workflows encode the safe two-phase structure; the
      posting harness they call is still being built.`);
}
