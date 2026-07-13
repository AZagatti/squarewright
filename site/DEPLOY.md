# Deploying the docs site (Cloudflare Workers static assets)

The site is a static Astro/Starlight build served as **Cloudflare Workers static assets** (the current replacement
for Cloudflare Pages). Config: [`wrangler.jsonc`](./wrangler.jsonc) — `assets.directory: "./dist"`, served at the
domain **root** (the `site/` and `dist/` folder names never appear in the URL).

## One-time: connect the repo to Workers Builds (dashboard)

There is no CLI token in the repo, so the first hookup is a dashboard step:

1. **Workers & Pages** → **Create** → **Workers** → **Import a repository** (or, for an existing Worker: open it →
   **Settings** → **Builds** → **Connect**). Pick this GitHub repo.
2. Set the build config:
   - **Worker name**: `squarewright-docs` — must match `name` in `wrangler.jsonc` or the build fails.
   - **Root directory**: `site` (this is a monorepo; the build runs here).
   - **Build command**: `bun install && bun run build`
   - **Deploy command**: `npx wrangler deploy` (the default)
3. Push to `main` → Workers Builds builds `site/dist` and deploys it. The URL is
   `squarewright-docs.<your-subdomain>.workers.dev` (or a custom domain you attach under the Worker's **Settings →
   Domains & Routes**).

After the first deploy, update `site` in [`astro.config.mjs`](./astro.config.mjs) to the real URL (it only affects
sitemap/canonical links).

## Manual deploy (if you have wrangler + an API token locally)

```bash
cd site
bun install
bun run deploy   # astro build && npx wrangler deploy
```

The previous GitHub Pages workflow was removed — Cloudflare is the single deploy target.
