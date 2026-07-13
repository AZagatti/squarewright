---
title: Install & first review
description: How to run Squarewright today (from source) and what the finished onboarding will look like.
---

## Today (pre-v0.1): assemble from source

There is no published package yet, so you run Squarewright from a checkout.

```bash
git clone https://github.com/AZagatti/squarewright
cd squarewright
bun install
```

The two GitHub Actions workflows (in `templates/workflows/`) encode the **safe two-phase** structure — an
untrusted *gather* job and a trusted *review* job. To review a PR locally against a gathered artifact:

```bash
bun run src/cli.ts review --phase post --input <artifact-dir>
```

Set the provider key matching your `.squarewright.yml` lanes (e.g. `ZAI_API_KEY` for the default free z.ai lanes).

## The finished path (ROADMAP M4)

Once the CLI is published, onboarding is two first-class paths, neither exclusive:

```bash
squarewright init      # scaffolds .squarewright.yml + the safe workflows into your repo
# add a provider-key secret in GitHub → open a PR → get a review
```

Run `squarewright doctor` to verify your key and config before opening a PR.

:::note
"No key required" is **not** the promise — an AI reviewer needs a model. The honest default is: bring one.
:::
