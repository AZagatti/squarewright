import { describe, expect, test } from "bun:test";
import { resolveProviderKeys } from "./keys.js";

describe("resolveProviderKeys", () => {
  test("collects resolved keys and reports missing ones by Pi's env-var label", async () => {
    // Fake the AuthStorage slice: zai resolves, openrouter does not. The env-var NAME comes from Pi
    // (getAuthStatus().label), not from a local <PROVIDER>_API_KEY guess.
    const auth = {
      getApiKey: (provider: string) =>
        Promise.resolve(provider === "zai" ? "z-key" : undefined),
      getAuthStatus: (provider: string) => ({
        label: provider === "openrouter" ? "OPENROUTER_API_KEY" : undefined,
      }),
    };

    const { apiKeys, missing } = await resolveProviderKeys(
      ["zai", "openrouter"],
      auth
    );

    expect(apiKeys).toEqual({ zai: "z-key" });
    expect(missing).toEqual(["OPENROUTER_API_KEY"]);
  });
});
