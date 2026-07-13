/**
 * Persona routing: given the changed files, decide which review lenses run. Glob-matched, docs-only-gated,
 * capped. Keeps cost bounded and attention focused (a generic single persona misses domain-specific classes).
 */
import type { ChangedFile, Persona } from "../core/types.js";

/** Extensions we treat as "code" (for needsCode gating — skip code personas on docs-only PRs). */
const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mts",
  "cts",
  "mjs",
  "cjs",
  "rs",
  "go",
  "py",
  "rb",
  "java",
  "kt",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "swift",
  "scala",
  "sh",
  "bash",
  "css",
  "scss",
  "sass",
  "sql",
  "yml",
  "yaml",
  "toml",
  "dockerfile",
]);

function ext(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (
    base.toLowerCase() === "dockerfile" ||
    base.toLowerCase().startsWith("dockerfile.")
  ) {
    return "dockerfile";
  }
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Minimal glob → RegExp: supports ** (any depth), * (within a segment), ? (one char). */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal charset of regex-special characters to escape, not an unterminated template literal
const REGEX_SPECIAL_CHARS = ".+^${}()|[]\\";

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === undefined) {
      break;
    }
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // `**/` = any number of leading path SEGMENTS, including none — emit the trailing `/` as a boundary so
          // `**/foo` only matches a whole-segment `foo` (`foo`, `a/foo`), never a partial name like `barfoo`.
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*"; // bare `**` crosses segments
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (REGEX_SPECIAL_CHARS.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Does a path match a glob? Full-path match; if the glob has no slash, also try the basename. */
export function matchGlob(glob: string, path: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(path)) {
    return true;
  }
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

/** The outcome of routing: which personas run, and which MATCHED the change-set but were cut by the cap. */
export interface PersonaSelection {
  /** personas that matched but were dropped by the cap — surfaced for honest coverage disclosure (never silent) */
  dropped: Persona[];
  /** personas that will run */
  selected: Persona[];
}

/**
 * Select the personas that should run for this change-set, and report which matched but were dropped by the cap.
 * The drop set is not cosmetic: `runReview` discloses it in the sticky so a capped review never *claims* to have
 * covered a lens it silently cut (e.g. the CI-security lens on a deps+Docker+CI PR).
 */
export function selectPersonasWithDrops(
  personas: Persona[],
  files: ChangedFile[],
  opts: { cap?: number } = {}
): PersonaSelection {
  const paths = files.map((f) => f.path);
  const hasCode = paths.some((p) => CODE_EXTS.has(ext(p)));

  const matched = personas.filter((p) => {
    // The AC-conformance auditor is context-gated (runs iff the PR has a fetched linkedIssue), not file/glob-gated —
    // `runReview` fires it as its own dedicated pass, so it never competes for the glob-routed cap here.
    if (p.acCheck) {
      return false;
    }
    if (p.needsCode && !hasCode) {
      return false;
    }
    if (isAlways(p)) {
      return true;
    }
    return (p.when ?? []).some((g) => paths.some((path) => matchGlob(g, path)));
  });

  if (opts.cap && matched.length > opts.cap) {
    const { cap } = opts;
    // priority order: always-on personas first, then the most-specific (scoped) matches
    const ordered = [
      ...matched.filter(isAlways),
      ...matched.filter((p) => !isAlways(p)),
    ];
    // Group-aware truncation: personas sharing an explicit `pass` are ONE indivisible unit — the cap must
    // never keep one member of a declared group while dropping its partner (that would silently run a
    // half-formed pair). Add whole units in priority order until the cap is full; skip a unit that wouldn't
    // fit rather than splitting it. With no `pass` anywhere, every unit is size 1 and this is a plain prefix.
    const seenGroups = new Set<string>();
    const units: Persona[][] = [];
    for (const p of ordered) {
      if (p.pass === undefined) {
        units.push([p]);
      } else if (!seenGroups.has(p.pass)) {
        seenGroups.add(p.pass);
        units.push(ordered.filter((q) => q.pass === p.pass));
      }
    }
    const kept: Persona[] = [];
    for (const unit of units) {
      if (kept.length + unit.length <= cap) {
        kept.push(...unit);
      }
    }
    const keptIds = new Set(kept.map((p) => p.id));
    // Preserve the original persona order in the drop list (readable disclosure), not the priority-sorted order.
    const dropped = matched.filter((p) => !keptIds.has(p.id));
    return { dropped, selected: kept };
  }
  return { dropped: [], selected: matched };
}

/** Select the personas that should run for this change-set. Thin wrapper over `selectPersonasWithDrops`. */
export function selectPersonas(
  personas: Persona[],
  files: ChangedFile[],
  opts: { cap?: number } = {}
): Persona[] {
  return selectPersonasWithDrops(personas, files, opts).selected;
}
