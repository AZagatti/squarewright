# Project conventions

## File copying

Recursive / directory file copies must go through the project's `copyDir` helper in
`packages/vite/src/node/utils.ts`. Do not call `fs.cpSync` / `fs.cp` directly: `copyDir`'s symlink-following and
cross-platform (Windows non-ASCII path) behavior is what our template scaffolding and public-dir copy depend on.
A change that removes `copyDir` or swaps it for `fs.cpSync` should be treated as a regression.
