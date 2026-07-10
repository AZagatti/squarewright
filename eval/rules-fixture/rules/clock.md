---
globs: ["src/**"]
---
- All wall-clock time MUST come from `now()` in `src/clock.ts`. NEVER call `Date.now()` or `new Date()`
  directly — it breaks the deterministic replay engine and makes tests non-reproducible.
