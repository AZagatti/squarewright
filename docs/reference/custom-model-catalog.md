# Custom model catalog (`models.json`)

Pi's bundled model catalog lags its live one: a model Pi already knows about upstream (e.g. a newest
OpenRouter release) is unreachable until we upgrade the pinned `@earendil-works/pi-coding-agent`, and shows up
as `Model not found in Pi's catalog`. Rather than wait for a package bump, drop a project-controlled
`models.json` that Squarewright merges over Pi's built-ins (custom wins on conflict) — so you can eval or ship a
newest model the day it lands. This unblocks the recall re-rank (#49 AC4) from being capped at whatever Pi
bundled (issue #76).

## How it's wired

Every model-using lane (worker, verifier, teach reply-interpreter, and the eval judge) builds its
`ModelRegistry` through `createModelRegistry()` in [`src/pi/model-catalog.ts`](../../src/pi/model-catalog.ts).
That helper resolves the catalog path and passes it to Pi's `ModelRegistry.create(authStorage, path)`:

1. `SQW_MODELS_JSON` — an explicit path, if set (used by tests/tools).
2. otherwise `models.json` at the working-directory root (same convention as `.squarewright.yml`).
3. otherwise none — built-in models only.

A malformed `models.json` is surfaced with a loud warning and the registry falls back to built-ins (it never
silently pretends there was no custom catalog).

## It REPLACES `~/.pi/agent/models.json` — it does not merge with it

Pi loads exactly **one** `models.json` — the one whose path is passed — and merges *that file's* models over the
built-ins. It does **not** also merge Pi's default per-user file at `~/.pi/agent/models.json`. So the moment a
project `models.json` (or `SQW_MODELS_JSON`) is active, the global file **stops being consulted entirely**.

This matters for money safety. [`models-reasoning-and-cost.md`](models-reasoning-and-cost.md) instructs putting
cost / reasoning-trap overrides — e.g. a `maxTokens` cap on a reasoning-mandatory model that would otherwise burn
a billing trap — in `~/.pi/agent/models.json`. If you add a project `models.json`, **port those overrides into
it too**, or they silently stop applying. `createModelRegistry` warns loudly when a project catalog supersedes an
existing global file, but the fix (porting the overrides) is yours.

## `models.json` diffs deserve the same scrutiny as code touching secrets

A `models.json` can redefine an existing provider's `baseUrl` (e.g. point `zai` at another host) while keeping
`authHeader: true`, which forwards the resolved API key as `Authorization: Bearer <key>` to that URL. The key
comes from `auth.json`/`/login`, never from the file — but a `models.json` diff is an easy place to miss a
secret-exfiltration vector precisely because it "doesn't look like code." Review catalog diffs accordingly.

## Adding a model

Copy the template and edit it:

```sh
cp models.json.example models.json
```

The schema is Pi's — see the package's `docs/models.md` for the full field list. Each model needs `id`,
`reasoning`, `input`, `contextWindow`, `maxTokens`, and `cost` (`input`/`output`/`cacheRead`/`cacheWrite`).
For reasoning-mandatory models, set the reasoning/effort fields correctly so the spend-guard reasoning-trap
check (`src/safety/spend-guard.ts`) still classifies them.

Curating *which* newest models to add is a deliberate choice (cost, reasoning-trap risk) left to the
maintainer; this repo ships the loader and the template, not a curated catalog.
