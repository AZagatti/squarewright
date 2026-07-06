/**
 * Persona routing: given the changed files, decide which review lenses run. Glob-matched, docs-only-gated,
 * capped. Keeps cost bounded and attention focused (a generic single persona misses domain-specific classes).
 */
import type { ChangedFile, Persona } from "../core/types.js";

/** Extensions we treat as "code" (for needsCode gating — skip code personas on docs-only PRs). */
const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs", "rs", "go", "py", "rb", "java", "kt", "c", "h",
  "cc", "cpp", "hpp", "cs", "php", "swift", "scala", "sh", "bash", "css", "scss", "sass", "sql",
  "yml", "yaml", "toml", "dockerfile",
]);

function ext(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (base.toLowerCase() === "dockerfile" || base.toLowerCase().startsWith("dockerfile.")) return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Minimal glob → RegExp: supports ** (any depth), * (within a segment), ? (one char). */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Does a path match a glob? Full-path match; if the glob has no slash, also try the basename. */
export function matchGlob(glob: string, path: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(path)) return true;
  if (!glob.includes("/")) {
    const base = path.split("/").pop() ?? path;
    return re.test(base);
  }
  return false;
}

/** A persona with no `when` (or `when: [always]`) runs on every reviewable change. */
function isAlways(p: Persona): boolean {
  return !p.when || p.when.length === 0 || p.when.includes("always");
}

/** Select the personas that should run for this change-set. */
export function selectPersonas(
  personas: Persona[],
  files: ChangedFile[],
  opts: { cap?: number } = {},
): Persona[] {
  const paths = files.map((f) => f.path);
  const hasCode = paths.some((p) => CODE_EXTS.has(ext(p)));

  const selected = personas.filter((p) => {
    if (p.needsCode && !hasCode) return false;
    if (isAlways(p)) return true;
    return (p.when ?? []).some((g) => paths.some((path) => matchGlob(g, path)));
  });

  if (opts.cap && selected.length > opts.cap) {
    // keep always-on personas first, then the most-specific matches, up to the cap
    const always = selected.filter(isAlways);
    const scoped = selected.filter((p) => !isAlways(p));
    return [...always, ...scoped].slice(0, opts.cap);
  }
  return selected;
}
