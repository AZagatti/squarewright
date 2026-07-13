import { expect, test } from "bun:test";
import { splitUnifiedDiff } from "./diff.js";

test("a plain modified file: path + status", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;
  const [f] = splitUnifiedDiff(diff);
  expect(f).toMatchObject({ path: "src/a.ts", status: "modified" });
});

test("status keywords in HUNK CONTENT do not misclassify a modified file", () => {
  // the added line literally contains "new file mode" — the old unanchored includes() called this "added"
  const diff = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1,2 @@
 const s = "new file mode";
+const t = "deleted file mode";
`;
  const [f] = splitUnifiedDiff(diff);
  expect(f?.status).toBe("modified"); // not "added"/"removed"
  expect(f?.path).toBe("src/x.ts");
});

test("a genuinely new file is 'added'", () => {
  const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 000..111
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+hello
`;
  const [f] = splitUnifiedDiff(diff);
  expect(f).toMatchObject({ path: "new.ts", status: "added" });
});

test("a deleted file keeps its path (from the --- side) and is 'removed'", () => {
  const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 111..000
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;
  const [f] = splitUnifiedDiff(diff);
  expect(f).toMatchObject({ path: "gone.ts", status: "removed" });
});

test("a pure rename (no ---/+++ lines) resolves the new path and 'renamed' status", () => {
  const diff = `diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
`;
  const [f] = splitUnifiedDiff(diff);
  expect(f).toMatchObject({ path: "new/name.ts", status: "renamed" });
});

test("a mode-only change (no ---/+++ lines) still resolves the path from the header", () => {
  const diff = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
`;
  const [f] = splitUnifiedDiff(diff);
  expect(f?.path).toBe("script.sh"); // not "(unknown)"
  expect(f?.status).toBe("modified");
});

test("a binary file (no ---/+++ lines) resolves the path from the header", () => {
  const diff = `diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`;
  const [f] = splitUnifiedDiff(diff);
  expect(f?.path).toBe("logo.png"); // not "(unknown)"
});

test("a quoted non-ASCII path (core.quotepath) is dequoted and octal-decoded", () => {
  // git renders café.txt as "b/caf\303\251.txt"
  const diff = `diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
index 111..222 100644
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-a
+b
`;
  const [f] = splitUnifiedDiff(diff);
  expect(f?.path).toBe("café.txt");
});

test("a path containing a space: the trailing disambiguation tab is stripped", () => {
  const diff = `diff --git a/my file.ts b/my file.ts
index 111..222 100644
--- a/my file.ts\t
+++ b/my file.ts\t
@@ -1 +1 @@
-a
+b
`;
  const [f] = splitUnifiedDiff(diff);
  expect(f?.path).toBe("my file.ts"); // no trailing tab
});

test("multiple distinct files do not collide on '(unknown)'", () => {
  const diff = `diff --git a/one.png b/one.png
index 1..2 100644
Binary files a/one.png and b/one.png differ
diff --git a/two.png b/two.png
index 3..4 100644
Binary files a/two.png and b/two.png differ
`;
  const out = splitUnifiedDiff(diff);
  expect(out.map((f) => f.path).sort((a, b) => a.localeCompare(b))).toEqual([
    "one.png",
    "two.png",
  ]);
});

test("empty diff → no entries", () => {
  expect(splitUnifiedDiff("")).toEqual([]);
});
