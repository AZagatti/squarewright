/**
 * Filesystem-backed {@link RepoReader} over a checked-out repo tree rooted at `root`. The TRUSTED review phase
 * uses it to read maintainer-authored files (Tier-A `.review-rules/*.md`) from the checkout the Review workflow
 * produces — which is the trusted **default-branch** tree, NEVER the PR head (`.github/workflows/squarewright-
 * review.yml` runs `actions/checkout@v4` with no ref, `contents: read` "checkout trusted base only").
 *
 * TRUST (Hard Rule #1): this factory takes ONLY a root path — it has no SHA/ref parameter, so it can never be
 * pointed at a PR-head revision; head-binding is a type-level impossibility, not a runtime promise. Its safety
 * rests on the caller checking out trusted content (the review workflow does). Path traversal is contained:
 * every request resolves under `root` and anything escaping it reads back as `null`.
 */
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { RepoReader } from "./session.js";

export function fsRepoReader(root: string): RepoReader {
  const base = resolve(root);
  // Resolve `path` under `base`; return null if it escapes the root (defense-in-depth for any future
  // model-driven reads — the rules loader only ever asks for paths it listed itself).
  const within = (path: string): string | null => {
    const abs = resolve(base, path);
    const rel = relative(base, abs);
    return rel.startsWith("..") || isAbsolute(rel) ? null : abs;
  };
  return {
    async listDir(path) {
      const abs = within(path);
      if (abs === null) {
        return null;
      }
      try {
        const entries = await readdir(abs, { withFileTypes: true });
        // Match the RepoReader entry format ("d name" / "- name") that `loadReviewRules` and the eval reader use.
        return entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`);
      } catch {
        return null;
      }
    },
    async readFile(path) {
      const abs = within(path);
      if (abs === null) {
        return null;
      }
      try {
        return await readFile(abs, "utf8");
      } catch {
        return null;
      }
    },
  };
}
