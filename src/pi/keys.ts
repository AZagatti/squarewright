/**
 * Resolve provider API keys from the environment. Pi's request path does not read env vars, so a caller must
 * hand keys to the worker explicitly. Convention: `<PROVIDER>_API_KEY` (e.g. openrouter → OPENROUTER_API_KEY).
 */
const PROVIDER_SEP = /[^a-z0-9]/gi;

/** The env var name a provider's key is read from. */
export function envApiKeyName(provider: string): string {
  return `${provider.replace(PROVIDER_SEP, "_").toUpperCase()}_API_KEY`;
}

/** Collect the set env keys for the given providers; a provider with no env var is omitted. */
export function envApiKeys(
  providers: Iterable<string>
): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const provider of providers) {
    const value = process.env[envApiKeyName(provider)];
    if (value) {
      keys[provider] = value;
    }
  }
  return keys;
}

/** Env-var names for the providers whose key is not set — the review must not start if any are missing. */
export function missingApiKeys(providers: Iterable<string>): string[] {
  const missing: string[] = [];
  for (const provider of providers) {
    const name = envApiKeyName(provider);
    if (!process.env[name]) {
      missing.push(name);
    }
  }
  return missing;
}
