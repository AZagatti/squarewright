---
title: How it works — two phases
description: The trust boundary that keeps your secrets away from untrusted pull-request code.
---

The dangerous part of an AI reviewer is running with **secrets** near **untrusted fork code**. Squarewright splits
the job into two workflows so they never meet — the trust boundary is the architecture, not a footnote.

## Phase 1 — Gather (untrusted)

Runs in the pull request's own context, possibly a fork. It has **no secrets** and only read permissions. It
collects the diff + metadata (and, opt-in, the acceptance criteria of a linked issue) as plain **data** and uploads
an artifact. Malicious PR code can do nothing valuable here, because there's nothing valuable here.

## Phase 2 — Review (trusted)

Triggered by the gather run completing (`workflow_run`). It has the **secrets** and posts the review — but it
**never checks out or executes PR head code**, and it **cross-checks the artifact's claimed head-SHA against the
trusted `workflow_run` event** before trusting it to decide where to post. A poisoned artifact cannot redirect a
comment.

```
   fork PR ──▶  Gather (untrusted, no secrets)  ──▶  artifact  ──▶  Review (trusted, secrets)  ──▶  PR comment
                       read-only, data only            head-SHA cross-checked before posting
```

This is why the review phase can safely hold a provider key even when the PR came from a stranger's fork.
