---
globs: ["**/*.ts"]
---
- Recursive / directory file copies MUST go through the project's `copyDir` helper in
  `packages/vite/src/node/utils.ts`. Do NOT call `fs.cpSync` / `fs.cp` directly: `copyDir`'s symlink-following
  and cross-platform (Windows non-ASCII path) behavior is what our template scaffolding and public-dir copy
  depend on. A change that removes `copyDir` or swaps it for `fs.cpSync` must be flagged.
