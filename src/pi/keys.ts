/**
 * Resolve provider API keys through Pi's own auth model — its provider→env-var map, stored auth, and OAuth
 * (see `@earendil-works/pi-ai` env-api-keys). Squarewright owns the policy (which providers a review needs),
 * not the key naming. Pi's request path doesn't read env, so we resolve here and hand keys to the worker
 * explicitly; a provider with no credential is reported by Pi's own env-var name.
 */
import { AuthStorage } from "@earendil-works/pi-coding-agent";

/** The slice of AuthStorage we depend on — narrowed so a test can supply a fake. */
interface ProviderAuth {
  getApiKey: (provider: string) => Promise<string | undefined>;
  getAuthStatus: (provider: string) => { label?: string };
}

export interface ResolvedKeys {
  /** provider → key, for the providers whose credential Pi could resolve */
  apiKeys: Record<string, string>;
  /** Pi's env-var name (or the provider id) for each provider with no credential */
  missing: string[];
}

/** Resolve keys for the given providers via Pi; report the missing ones by Pi's own env-var name. */
export async function resolveProviderKeys(
  providers: Iterable<string>,
  auth: ProviderAuth = AuthStorage.create()
): Promise<ResolvedKeys> {
  const list = [...providers];
  const keys = await Promise.all(list.map((p) => auth.getApiKey(p)));
  const apiKeys: Record<string, string> = {};
  const missing: string[] = [];
  for (const [i, provider] of list.entries()) {
    const key = keys[i];
    if (key) {
      apiKeys[provider] = key;
    } else {
      missing.push(auth.getAuthStatus(provider).label ?? provider);
    }
  }
  return { apiKeys, missing };
}
