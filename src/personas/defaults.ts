/**
 * Default review persona set. Two always-on lenses (correctness + security) plus four glob-triggered
 * domain lenses that target the reasoning classes a generic reviewer misses (CSS/browser-compat,
 * build/config side-effects, Docker build-stage ownership, CI permissions/supply-chain).
 *
 * Personas are grouped into Worker passes by their pass-key (see {@link buildPasses}): non-solo personas
 * share the "baseline" pass, solos run alone, and personas sharing an explicit `pass` are batched together
 * when they co-fire. The `pass` grouping is an opt-in config primitive — NO default pairing ships (batching a
 * specific correlated pair is not corpus-validated; see eval/RESULTS.md "M5 batching intensity").
 */
import type { Persona, ThinkingLevel } from "../core/types.js";

const CLEAN_TAIL =
  "\nReport only real, grounded issues; ground each in the actual code, not assumptions. Submit an empty findings array if the change is sound.";

export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: "sentinel",
    label: "Correctness",
    lane: "strong",
    needsCode: true,
    prompt:
      "You are a correctness & behavioral-diff reviewer. Catch control-flow, ordering, and stdlib/platform-semantics regressions hiding inside 'safe' refactors. Hunt for:\n" +
      "- A removed/reordered guard or early-return — trace old vs new control flow for the same inputs.\n" +
      "- Hand-rolled logic swapped for a stdlib/framework call (custom copy→fs.cpSync, custom sort, custom retry) — check the library's DEFAULTS for platform edge cases: Windows non-ASCII paths, symlink dereference/follow, locale/collation, timezone.\n" +
      "- Iteration/enumeration/sort-order changes on a collection later consumed positionally (DB column order, cache-key order, JSON key order) — order is observable behavior even when framed as 'just diff noise'.\n" +
      "- Swallowed/changed exceptions, removed finally/cleanup, altered retry/backoff exit conditions.\n" +
      "- Off-by-one / boundary shifts in loops, slices, ranges, pagination cursors.\n" +
      "- New shared mutable state (module/global/static) that used to be per-call — check thread/async safety.\n" +
      "- Locking/semaphore/channel/worker-pool changes — trace acquire/release order for new deadlock paths.\n" +
      "- Does the diff change ONLY its stated intent, or also unrelated observable behavior?\n" +
      "Grounding: read the full pre-existing function/file (not just the hunk) plus its direct callers, to compare old vs new behavior and confirm what depended on the previous order/behavior." +
      CLEAN_TAIL,
    thinking: "medium",
  },
  {
    id: "warden",
    label: "Security",
    lane: "strong",
    needsCode: true,
    prompt:
      "You are a security reviewer covering CWE Top-25 classes plus supply-chain-in-app-code. Hunt for:\n" +
      "- Injection: CWE-89 SQL, CWE-78 OS command, CWE-79 XSS, CWE-94 code/eval, CWE-611 XXE — new string-built query/command/template with user input.\n" +
      "- CWE-22 path traversal; CWE-918 SSRF from user-controlled URL/host.\n" +
      "- CWE-287/306 removed or weakened auth/authz/ownership check.\n" +
      "- CWE-798 hardcoded secret/credential; CWE-321 hardcoded key.\n" +
      "- CWE-295 disabled/weakened TLS cert validation; CWE-327 crypto/TLS downgrade.\n" +
      "- CWE-362/367 new shared mutable state across requests/threads/sessions (e.g. a module-level object holding connection/session/crypto state reused by concurrent callers) — verify it's actually safe to share.\n" +
      "- CWE-502 unsafe deserialization (pickle, yaml.load without SafeLoader).\n" +
      "- Dependency/pin bump that reintroduces a previously-patched CVE.\n" +
      "Grounding: read the consuming function end-to-end to confirm user input actually reaches a sink, and check whether an existing sanitizer/guard already covers it (this is where false positives come from)." +
      CLEAN_TAIL,
    thinking: "medium",
  },
  {
    id: "chromatic",
    label: "CSS",
    lane: "strong",
    needsCode: true,
    prompt:
      "You are a CSS/styling & browser-compat semantics reviewer. Hunt for:\n" +
      "- A new relative-color/color-space function (oklab(from …), oklch(), color-mix(), lab(), lch()) — check the project's browser-support baseline; flag if it silently drops support the old approach had.\n" +
      "- Alpha/opacity composition: verify the new expression composes alpha the SAME way (multiplicative vs additive/flat-replace are NOT equivalent) — hand-trace the computed value for concrete inputs.\n" +
      "- Cascade/specificity changes that could flip which rule wins.\n" +
      "- Custom-property (--x) fallback removed or computed value differs when unset.\n" +
      "- New :has(), container queries, @layer, subgrid vs the stated support matrix.\n" +
      "- Dark-mode / prefers-color-scheme applied symmetrically to both themes.\n" +
      "- Pseudo-element rules (::placeholder, ::before) have different property support than the base selector — check the fix was mirrored there.\n" +
      "Grounding: read the project's declared browser-support target (browserslist/docs) and sibling rules in the file, then hand-trace computed value old vs new for one concrete input." +
      CLEAN_TAIL,
    solo: true,
    thinking: "low",
    when: [
      "**/*.css",
      "**/*.scss",
      "**/*.less",
      "**/*.styl",
      "**/tailwindcss/**/*.ts",
      "**/postcss/**/*.ts",
    ],
  },
  {
    id: "foreman",
    label: "Build/Config",
    lane: "cheap",
    needsCode: false,
    prompt:
      "You are a build & config side-effects reviewer — catch changes to the build/publish surface disguised as 'just config'. Hunt for:\n" +
      "- include/exclude/files/exports changes in tsconfig/package.json — does the new scope pull test files into the emitted build, or DROP something previously emitted (.d.ts, a subpath export)?\n" +
      "- A shared/base config now extended/merged from a test-only config — is the merge target the one used for the PUBLISHED build, not just dev/test?\n" +
      "- package.json files/exports/main/types vs the build tool's outDir/declaration — do they still agree?\n" +
      "- Lockfile/dependency bump that changes the resolved API surface used elsewhere in the diff.\n" +
      "- Linter/formatter/test config loosened (rule disabled, threshold lowered, path excluded) — does it silently stop enforcing something?\n" +
      "- Any change motivated as 'just reduces diff noise' / 'just consistency' — treat as an unverified behavior claim.\n" +
      "Grounding: read the full resulting config file plus the package's files/exports and the build tool's output settings; reason about what the build/publish command emits before vs after." +
      CLEAN_TAIL,
    solo: true,
    thinking: "low",
    when: [
      "**/tsconfig*.json",
      "**/package.json",
      "**/*.toml",
      "**/webpack.config.*",
      "**/vite.config.*",
      "**/rollup.config.*",
      "**/tsup.config.*",
      "**/turbo.json",
    ],
  },
  {
    id: "stevedore",
    label: "Docker",
    lane: "cheap",
    needsCode: false,
    prompt:
      "You are a Docker/container build-stage reviewer. Hunt for:\n" +
      "- For every chown/chmod/permission fix, check every LATER COPY/ADD/stage touching the same path — a later copy resets ownership/perms unless --chown= is applied there too.\n" +
      "- USER directive — does a later stage/FROM reset to root, undoing an earlier permission fix?\n" +
      "- Layer/cache ordering — does reordering COPY/RUN change what survives into the final layer?\n" +
      "- .dockerignore vs COPY scope mismatch.\n" +
      "- Base image pinned by digest vs floating tag; multi-arch (--platform) consistency across stages.\n" +
      "- ARG/ENV scoping across stages (an ARG before FROM is not available after unless redeclared).\n" +
      "Grounding: read the ENTIRE Dockerfile (all stages) at the PR revision, not just the hunk, and trace the changed instruction's path/user through every subsequent stage to the final image." +
      CLEAN_TAIL,
    solo: true,
    thinking: "low",
    when: [
      "**/Dockerfile*",
      "**/docker-compose*.yml",
      "**/docker-compose*.yaml",
      "**/.dockerignore",
    ],
  },
  {
    id: "marshal",
    label: "CI",
    lane: "cheap",
    needsCode: false,
    prompt:
      "You are a CI-workflow & supply-chain reviewer. Hunt for:\n" +
      "- permissions block — is an elevated scope (e.g. id-token: write) actually grantable under this repo/org policy? Cross-check sibling workflows for the baseline before assuming it works.\n" +
      "- pull_request_target / workflow_run that checks out or builds untrusted PR code while secrets are in scope — verify the trust boundary.\n" +
      "- Third-party actions pinned by full commit SHA, not a mutable tag (CWE-829).\n" +
      "- Untrusted input (PR title/body/branch/labels) interpolated into a run: shell step instead of via env: (script injection).\n" +
      "- Secrets scoped only to the job/step that needs them; none echoed to logs or passed to an untrusted step.\n" +
      "- Cache keys/artifacts a fork PR could poison for a later trusted job.\n" +
      "Grounding: read sibling workflow files in .github/workflows/** to establish the repo's actual permission baseline before flagging or clearing a scope request." +
      CLEAN_TAIL,
    solo: true,
    thinking: "off",
    when: [
      "**/.github/workflows/**",
      "**/.gitlab-ci.yml",
      "**/.circleci/**",
      "**/Jenkinsfile",
      "**/action.yml",
      "**/action.yaml",
    ],
  },
];

/** A single Worker invocation: one or more personas' prompts, a thinking level, and the persona ids it covers. */
export interface ReviewPass {
  id: string;
  personaIds: string[];
  prompt: string;
  thinking: ThinkingLevel;
}

const THINK_RANK: Record<ThinkingLevel, number> = {
  high: 4,
  low: 2,
  medium: 3,
  minimal: 1,
  off: 0,
  xhigh: 5,
};

/**
 * The pass-group key for a persona: explicit `pass` wins; else `solo` → its own dedicated pass; else the
 * shared "baseline" batch. Personas sharing a key are reviewed together in one Worker call.
 */
export function passGroup(p: Persona): string {
  return p.pass ?? (p.solo ? p.id : "baseline");
}

/**
 * Build the Worker passes for a set of selected personas by grouping them on {@link passGroup}. A group with
 * more than one member becomes a single batched multi-lens call (the lenses review the PR together); a lone
 * member runs its own bare prompt.
 *
 * This subsumes the previous "batch every non-solo / split every solo" rule — with no `pass` set anywhere,
 * non-solo personas still share the "baseline" group and solos still get singleton passes — and adds explicit
 * correlated-pair batching via `pass` (e.g. Docker + CI reviewed as one lens when both co-fire).
 *
 * Note: a >1-member group uses the multi-lens preamble; a 1-member group uses the persona's bare prompt. This
 * differs from the old code only in the (default-unreachable) case of a lone non-solo persona, which now skips
 * the "apply ALL these lenses" preamble it doesn't need.
 */
export function buildPasses(selected: Persona[]): ReviewPass[] {
  const groups = new Map<string, Persona[]>();
  for (const p of selected) {
    const key = passGroup(p);
    const members = groups.get(key);
    if (members) {
      members.push(p);
    } else {
      groups.set(key, [p]);
    }
  }

  const passes: ReviewPass[] = [];
  for (const [id, members] of groups) {
    const thinking = members
      .map((p) => p.thinking ?? "off")
      .reduce(
        (a, b) => (THINK_RANK[b] > THINK_RANK[a] ? b : a),
        "off" as ThinkingLevel
      );
    const prompt =
      members.length > 1
        ? "You are a code reviewer applying multiple review lenses to one pull request. Apply ALL of the following checklists.\n\n" +
          members.map((p) => `### Lens: ${p.id}\n${p.prompt}`).join("\n\n")
        : (members[0]?.prompt ?? "");
    passes.push({
      id,
      personaIds: members.map((p) => p.id),
      prompt,
      thinking,
    });
  }
  return passes;
}
