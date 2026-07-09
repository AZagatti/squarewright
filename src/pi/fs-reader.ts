/**
 * Filesystem-backed {@link RepoReader} over a checked-out repo tree rooted at `root`. The TRUSTED review phase
 * uses it to read maintainer-authored files (Tier-A `.review-rules/*.md`) from the checkout the Review workflow
 * produces. That checkout is the trusted **default-branch** tree, NEVER the PR head — specifically because the
 * workflow is triggered by `workflow_run` (not `pull_request`), for which a no-`ref` `actions/checkout@v4`
 * resolves to the default-branch tip, not a `refs/pull/N/merge` commit — that trigger IS the guarantee. The
 * workflow adds a best-effort tripwire (refuse if the PR head commit is HEAD or an ancestor of it) as
 * defense-in-depth; it can't fully prove base-binding under a shallow clone, so don't rely on it alone.
 *
 * TRUST (Hard Rule #1): this factory takes ONLY a root path — it has no SHA/ref parameter, so it can never be
 * pointed at a PR-head revision; head-binding is a type-level impossibility, not a runtime promise. Its safety
 * rests on the caller checking out trusted content (the review workflow does). Lexical path traversal is
 * contained: every request resolves under `root` and any `..`/absolute path that escapes it reads back as
 * `null`. (A symlink *inside* the tree pointing outside is not caught here — that needs a symlink already merged
 * into the trusted branch through review, a different trust tier than the PR-head/base line this reader defends.)
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
        // Sort by name so the reader is a deterministic primitive regardless of filesystem order (ext4 hash
        // order, APFS/tmpfs arbitrary). `loadReviewRules` also sorts, but a deterministic reader is cleaner and
        // keeps prompt order reproducible for any consumer. Match the RepoReader entry format ("d name"/"- name").
        return entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`);
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
