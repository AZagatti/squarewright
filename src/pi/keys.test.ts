import { afterEach, describe, expect, test } from "bun:test";
import { envApiKeyName, envApiKeys, missingApiKeys } from "./keys.js";

describe("envApiKeyName", () => {
  test("maps provider ids to <PROVIDER>_API_KEY", () => {
    expect(envApiKeyName("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(envApiKeyName("zai")).toBe("ZAI_API_KEY");
    expect(envApiKeyName("anthropic")).toBe("ANTHROPIC_API_KEY");
  });
});

describe("envApiKeys", () => {
  const NAMES = ["OPENROUTER_API_KEY", "ZAI_API_KEY", "ANTHROPIC_API_KEY"];
  const saved = new Map(NAMES.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const [n, v] of saved) {
      if (v === undefined) {
        delete process.env[n];
      } else {
        process.env[n] = v;
      }
    }
  });

  test("collects only providers whose env var is set and non-empty", () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    process.env.ZAI_API_KEY = ""; // empty → treated as unset
    delete process.env.ANTHROPIC_API_KEY;
    expect(envApiKeys(["openrouter", "zai", "anthropic"])).toEqual({
      openrouter: "or-key",
    });
  });

  test("missingApiKeys lists the env vars for providers with no key", () => {
    process.env.ZAI_API_KEY = "z";
    process.env.OPENROUTER_API_KEY = ""; // empty → treated as missing
    expect(missingApiKeys(["zai", "openrouter"])).toEqual([
      "OPENROUTER_API_KEY",
    ]);
  });
});
