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
      catalogWarnings: () => [],
      hasGh: () => Promise.resolve(true),
      loadConfig: () => CONFIG,
      // the review needs only zai (the lane AND the default free z.ai structurer)
      resolveKeys: () =>
        Promise.resolve({
          apiKeys: { zai: "z" },
          missing: [],
        }),
    });

    expect(report.config).toEqual({ lanes: 1, personas: 1 });
    expect(report.configError).toBeNull();
    expect(report.providers).toEqual([{ present: true, provider: "zai" }]);
    expect(report.gh).toBe(true);
    expect(report.catalogWarnings).toEqual([]);
    expect(doctorProblems(report)).toBe(0);
  });

  test("a missing required key is a problem", async () => {
    const report = await runDoctor(".", {
      catalogWarnings: () => [],
      hasGh: () => Promise.resolve(true),
      loadConfig: () => CONFIG,
      resolveKeys: () =>
        Promise.resolve({
          apiKeys: {},
          missing: ["ZAI_API_KEY"],
        }),
    });

    expect(report.providers).toContainEqual({
      present: false,
      provider: "zai",
    });
    expect(doctorProblems(report)).toBe(1);
  });

  test("an invalid/missing config is a problem, and providers aren't checked", async () => {
    let resolveCalled = false;
    const report = await runDoctor(".", {
      catalogWarnings: () => [],
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
      catalogWarnings: () => [],
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

  test("a models.json money warning surfaces but is not a hard problem (#194)", async () => {
    const warning =
      "⚠️  models.json: 1 custom model(s) declared with no `cost` block";
    const report = await runDoctor(".", {
      catalogWarnings: () => [warning],
      hasGh: () => Promise.resolve(true),
      loadConfig: () => CONFIG,
      resolveKeys: () =>
        Promise.resolve({ apiKeys: { zai: "z" }, missing: [] }),
    });

    expect(report.catalogWarnings).toEqual([warning]);
    // a valid-but-costless catalog must not fail doctor hard — it's a visible warning, like a missing gh
    expect(doctorProblems(report)).toBe(0);
    expect(renderDoctor(report)).toContain(warning);
  });
});

describe("renderDoctor", () => {
  test("renders check marks and a clean verdict when healthy", () => {
    const out = renderDoctor({
      catalogWarnings: [],
      config: { lanes: 1, personas: 1 },
      configError: null,
      gh: true,
      providers: [{ present: true, provider: "zai" }],
    });

    expect(out).toContain("✓ .squarewright.yml valid");
    expect(out).toContain("✓ zai — key present");
    expect(out).toContain("No problems found");
    // no Model catalog section when there are no warnings
    expect(out).not.toContain("Model catalog");
  });

  test("renders the config error and a problem count when broken", () => {
    const out = renderDoctor({
      catalogWarnings: [],
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

  test("renders a Model catalog section for money warnings (#194)", () => {
    const out = renderDoctor({
      catalogWarnings: ["⚠️  models.json: reports $0 cost, HIDING real spend"],
      config: { lanes: 1, personas: 1 },
      configError: null,
      gh: true,
      providers: [{ present: true, provider: "zai" }],
    });

    expect(out).toContain("Model catalog");
    expect(out).toContain("HIDING real spend");
  });
});
