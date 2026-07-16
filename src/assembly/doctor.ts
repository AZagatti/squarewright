/**
 * `squarewright doctor` — verify an assembly is ready to run before a real review is attempted: the config
 * parses, every required provider key resolves, and `gh` is available for posting. It only checks *presence*
 * (no network provider ping, no paid call). Every effect is injected, so the logic is testable without a real
 * config, credentials, or `gh`.
 */
import type { ResolvedKeys } from "../pi/keys.js";
import type { AssemblyConfig } from "./config.js";
import { requiredProviders } from "./review-post.js";

interface DoctorDeps {
  /** money/honesty warnings for the resolved models.json catalog (see `catalogWarnings` in pi/model-catalog) */
  catalogWarnings: () => string[];
  hasGh: () => Promise<boolean>;
  loadConfig: (cwd: string) => AssemblyConfig;
  resolveKeys: (providers: Iterable<string>) => Promise<ResolvedKeys>;
}

interface ProviderCheck {
  present: boolean;
  provider: string;
}

export interface DoctorReport {
  /** models.json money/honesty warnings (missing cost = hidden $0 spend, supersession, …); [] when clean */
  catalogWarnings: string[];
  /** lanes/personas counts when the config loaded */
  config: { lanes: number; personas: number } | null;
  /** null when the config loaded; the loader's error message otherwise */
  configError: string | null;
  /** whether the `gh` CLI is available (needed to post, not to dry-run) */
  gh: boolean;
  /** the config's providers whose key is/ isn't resolvable (empty when the config didn't load) */
  providers: ProviderCheck[];
}

async function checkProviders(
  config: AssemblyConfig,
  resolveKeys: DoctorDeps["resolveKeys"]
): Promise<ProviderCheck[]> {
  const providers = [...requiredProviders(config)].sort();
  const { apiKeys } = await resolveKeys(providers);
  return providers.map((provider) => ({
    present: provider in apiKeys,
    provider,
  }));
}

/** Run the checks and return a structured report — the CLI renders it and decides the exit code. */
export async function runDoctor(
  cwd: string,
  deps: DoctorDeps
): Promise<DoctorReport> {
  let config: AssemblyConfig | null = null;
  let configError: string | null = null;
  try {
    config = deps.loadConfig(cwd);
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
  }

  const providers = config
    ? await checkProviders(config, deps.resolveKeys)
    : [];
  const gh = await deps.hasGh();

  return {
    catalogWarnings: deps.catalogWarnings(),
    config: config
      ? { lanes: config.lanes.length, personas: config.personas.length }
      : null,
    configError,
    gh,
    providers,
  };
}

/** A hard problem means a review can't run: the config is invalid, or a required provider key is missing. */
export function doctorProblems(report: DoctorReport): number {
  const configProblem = report.configError ? 1 : 0;
  const keyProblems = report.providers.filter((p) => !p.present).length;
  return configProblem + keyProblems;
}

/** Human-readable ✓/✗ report. A missing `gh` is a warning, not a hard problem (dry-run needs no posting). */
export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = ["squarewright doctor", "", "Config"];
  if (report.config) {
    lines.push(
      `  ✓ .squarewright.yml valid (${report.config.lanes} lane(s), ${report.config.personas} persona(s))`
    );
  } else {
    lines.push(`  ✗ ${report.configError}`);
  }

  if (report.providers.length > 0) {
    lines.push("", "Providers");
    for (const p of report.providers) {
      lines.push(
        p.present
          ? `  ✓ ${p.provider} — key present`
          : `  ✗ ${p.provider} — key missing`
      );
    }
  }

  if (report.catalogWarnings.length > 0) {
    lines.push("", "Model catalog");
    for (const warning of report.catalogWarnings) {
      // each warning already carries its own ⚠️ prefix and full explanation
      lines.push(`  ${warning}`);
    }
  }

  lines.push(
    "",
    "Tools",
    report.gh
      ? "  ✓ gh CLI available"
      : "  ⚠ gh CLI not found — needed to post reviews (not for a dry-run)"
  );

  const problems = doctorProblems(report);
  lines.push(
    "",
    problems === 0
      ? "No problems found. ✅"
      : `${problems} problem(s) found — resolve them before running a review.`
  );
  return lines.join("\n");
}
