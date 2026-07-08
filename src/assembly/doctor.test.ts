import { describe, expect, test } from "bun:test";
import type { AssemblyConfig } from "./config.js";
import { doctorProblems, renderDoctor, runDoctor } from "./doctor.js";

const CONFIG: AssemblyConfig = {
  grounders: [],
  lanes: [{ id: "cheap", model: "glm-5-turbo", provider: "zai" }],
  personas: [{ id: "gen", lane: "cheap", prompt: "x", when: ["always"] }],
};

describe("runDoctor", () => {
  test("all green: config valid, every required key present, gh available", async () => {
    const report = await runDoctor(".", {
      hasGh: () => Promise.resolve(true),
      loadConfig: () => CONFIG,
      // the review needs zai (the lane) + openrouter (the structurer)
      resolveKeys: () =>
        Promise.resolve({
          apiKeys: { openrouter: "or", zai: "z" },
          missing: [],
        }),
    });

    expect(report.config).toEqual({ lanes: 1, personas: 1 });
    expect(report.configError).toBeNull();
    expect(report.providers).toEqual([
      { present: true, provider: "openrouter" },
      { present: true, provider: "zai" },
    ]);
    expect(report.gh).toBe(true);
    expect(doctorProblems(report)).toBe(0);
  });

  test("a missing required key is a problem", async () => {
    const report = await runDoctor(".", {
      hasGh: () => Promise.resolve(true),
      loadConfig: () => CONFIG,
      resolveKeys: () =>
        Promise.resolve({
          apiKeys: { zai: "z" },
          missing: ["OPENROUTER_API_KEY"],
        }),
    });

    expect(report.providers).toContainEqual({
      present: false,
      provider: "openrouter",
    });
    expect(doctorProblems(report)).toBe(1);
  });

  test("an invalid/missing config is a problem, and providers aren't checked", async () => {
    let resolveCalled = false;
    const report = await runDoctor(".", {
      hasGh: () => Promise.resolve(true),
      loadConfig: () => {
        throw new Error("No .squarewright.yml in .");
      },
      resolveKeys: () => {
        resolveCalled = true;
        return Promise.resolve({ apiKeys: {}, missing: [] });
      },
    });

    expect(report.config).toBeNull();
    expect(report.configError).toContain("No .squarewright.yml");
    expect(report.providers).toEqual([]);
    expect(resolveCalled).toBe(false);
    expect(doctorProblems(report)).toBe(1);
  });

  test("a missing gh is a warning, not a hard problem", async () => {
    const report = await runDoctor(".", {
      hasGh: () => Promise.resolve(false),
      loadConfig: () => CONFIG,
      resolveKeys: () =>
        Promise.resolve({
          apiKeys: { openrouter: "or", zai: "z" },
          missing: [],
        }),
    });

    expect(report.gh).toBe(false);
    expect(doctorProblems(report)).toBe(0);
  });
});

describe("renderDoctor", () => {
  test("renders check marks and a clean verdict when healthy", () => {
    const out = renderDoctor({
      config: { lanes: 1, personas: 1 },
      configError: null,
      gh: true,
      providers: [{ present: true, provider: "zai" }],
    });

    expect(out).toContain("✓ .squarewright.yml valid");
    expect(out).toContain("✓ zai — key present");
    expect(out).toContain("No problems found");
  });

  test("renders the config error and a problem count when broken", () => {
    const out = renderDoctor({
      config: null,
      configError: "No .squarewright.yml in .",
      gh: false,
      providers: [],
    });

    expect(out).toContain("✗ No .squarewright.yml");
    expect(out).toContain("⚠ gh CLI not found");
    expect(out).toContain("1 problem(s) found");
    // no Providers section when the config didn't load
    expect(out).not.toContain("Providers");
  });
});
