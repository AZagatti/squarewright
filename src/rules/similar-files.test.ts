import { expect, test } from "bun:test";
import type { RepoReader } from "../pi/session.js";
import { loadSimilarFiles, renderSimilarFiles } from "./similar-files.js";

/** A fake reader over an in-memory tree: dirs → entry lists ("- name"/"d name"), files → contents. */
function fakeReader(
  dirs: Record<string, string[]>,
  files: Record<string, string>
): RepoReader {
  return {
    listDir: (path) => Promise.resolve(dirs[path] ?? null),
    readFile: (path) => Promise.resolve(files[path] ?? null),
  };
}

test("picks same-dir, same-ext siblings, not the changed file, ranked by name overlap", async () => {
  const reader = fakeReader(
    {
      "src/auth": [
        "- session.ts",
        "- session-store.ts",
        "- login.ts",
        "- README.md",
        "d nested",
      ],
    },
    {
      "src/auth/login.ts": "login code",
      "src/auth/session-store.ts": "store code",
    }
  );
  const out = await loadSimilarFiles(reader, ["src/auth/session.ts"], {
    perFile: 2,
  });
  // session-store.ts (shares the "session" token) ranks before login.ts; README.md (wrong ext) + the changed
  // file itself + the subdir are excluded.
  expect(out.map((f) => f.path)).toEqual([
    "src/auth/session-store.ts",
    "src/auth/login.ts",
  ]);
});

test("excludes files that are themselves in the diff", async () => {
  const reader = fakeReader(
    { src: ["- a.ts", "- b.ts", "- c.ts"] },
    { "src/b.ts": "b", "src/c.ts": "c" }
  );
  // a.ts and b.ts are both changed → only c.ts is a valid sibling
  const out = await loadSimilarFiles(reader, ["src/a.ts", "src/b.ts"], {
    perFile: 3,
  });
  expect(out.map((f) => f.path)).toEqual(["src/c.ts"]);
});

test("respects the total cap and per-file body size cap", async () => {
  const reader = fakeReader(
    { src: ["- a.ts", "- s1.ts", "- s2.ts", "- s3.ts"] },
    {
      "src/s1.ts": "x".repeat(9000),
      "src/s2.ts": "y",
      "src/s3.ts": "z",
    }
  );
  const out = await loadSimilarFiles(reader, ["src/a.ts"], {
    maxChars: 100,
    perFile: 5,
    total: 2,
  });
  expect(out).toHaveLength(2); // total cap
  expect(out[0]?.body.length).toBeLessThanOrEqual(100); // body cap
});

test("no siblings / unreadable dir → empty, and render is empty-safe", async () => {
  const reader = fakeReader({}, {});
  const out = await loadSimilarFiles(reader, ["src/only.ts"]);
  expect(out).toEqual([]);
  expect(renderSimilarFiles(out)).toBe("");
});

test("render frames the siblings as reference-only, not under review", () => {
  const rendered = renderSimilarFiles([{ body: "code", path: "src/x.ts" }]);
  expect(rendered).toContain("src/x.ts");
  expect(rendered).toContain("NOT part of the diff");
  expect(rendered).toContain("Do NOT report pre-existing issues");
});
