/**
 * `squarewright init` — scaffolds a working reviewer assembly into a repo. Generated files are THIN and clone
 * the versioned squarewright harness at a pinned ref; the heavy logic stays upstream, upgradable (ADR-0001).
 */
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDefaultConfig } from "./default-config.js";

const TEMPLATES_DIR = fileURLToPath(
  new URL("../../templates/", import.meta.url)
);
/** squarewright's own repo root — used to pin the scaffolded workflows to the revision that ran `init`. */
const SQUAREWRIGHT_ROOT = join(TEMPLATES_DIR, "..");

/** Placeholder the templated workflows carry; replaced with {@link resolveSquarewrightRef}. */
const REF_PLACEHOLDER = "__SQW_REF__";

/**
 * The git ref the scaffolded workflows clone. Pins to the squarewright revision running `init` — but ONLY when
 * squarewright is its own git checkout (the source/dogfood case); when it runs as a package nested in the user's
 * repo (`node_modules/squarewright`), `git` would resolve the *user's* HEAD, which is not a squarewright ref, so
 * we fall back to `main`. Users can retarget the ref (to a tag) in the generated workflow.
 */
function resolveSquarewrightRef(): string {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: SQUAREWRIGHT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    // Only trust HEAD when SQUAREWRIGHT_ROOT is itself the git top-level (not nested inside the user's repo).
    if (
      resolve(git(["rev-parse", "--show-toplevel"])) !==
      resolve(SQUAREWRIGHT_ROOT)
    ) {
      return "main";
    }
    return git(["rev-parse", "HEAD"]) || "main";
  } catch {
    return "main";
  }
}

interface CopySpec {
  from: string; // relative to templates/
  to: string; // relative to repo root
}

/** Files copied verbatim (no per-repo substitution needed). */
const COPY_SPECS: CopySpec[] = [
  {
    from: "workflows/squarewright-gather.yml",
    to: ".github/workflows/squarewright-gather.yml",
  },
  { from: "review-rules/README.md", to: ".review-rules/README.md" },
];

/** Workflows whose `__SQW_REF__` placeholder is replaced with the pinned harness ref. */
const TEMPLATED_SPECS: CopySpec[] = [
  {
    from: "workflows/squarewright-review.yml",
    to: ".github/workflows/squarewright-review.yml",
  },
  {
    from: "workflows/squarewright-teach.yml",
    to: ".github/workflows/squarewright-teach.yml",
  },
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
  const ref = resolveSquarewrightRef();

  for (const spec of COPY_SPECS) {
    const dest = join(repoRoot, spec.to);
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design — deterministic, ordered console output
    await placeFile(dest, spec.to, () =>
      cp(join(TEMPLATES_DIR, spec.from), dest)
    );
  }

  for (const spec of TEMPLATED_SPECS) {
    const dest = join(repoRoot, spec.to);
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design — deterministic, ordered console output
    await placeFile(dest, spec.to, async () => {
      const template = await readFile(join(TEMPLATES_DIR, spec.from), "utf8");
      await writeFile(dest, template.replaceAll(REF_PLACEHOLDER, ref));
    });
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
  3. (Optional) Pin the harness — the workflows clone squarewright@${ref}. Change SQUAREWRIGHT_REF in them to a
     release tag for a fixed version, or "main" to track latest.
  4. Open a PR — Gather runs untrusted (no secrets); Review runs trusted, clones the pinned harness, and posts.

Docs: https://github.com/AZagatti/squarewright/blob/main/docs/ROADMAP.md`);
}
