---
title: Acceptance-criteria checks
description: Flag when a PR silently leaves an acceptance criterion of its linked issue unmet.
---

When a PR closes an issue (`Closes #123`), Squarewright can check the PR against that issue's **acceptance
criteria** and flag any that were **silently** left unmet — a gap no defect-finding persona catches, because it's
not a code bug. In the project's own history, a bug-free, tested, adversarially-reviewed PR shipped without meeting
its explicit ship-gate, and nothing caught it until this check did.

This is **opt-in**, because the silent-vs-justified judgment needs a genuinely strong model (the free default is
unreliable at it — see the [eval record](https://github.com/AZagatti/squarewright/blob/main/eval/RESULTS.md)). Add
an auditor persona on a **strong** lane:

```yaml
personas:
  - id: auditor
    label: Acceptance criteria
    acCheck: true          # runs only on PRs that close an issue; its own pass
    lane: strong           # point "strong" at a capable model, not the free default
    prompt: "You audit whether the PR satisfies the linked issue's acceptance criteria."
```

The gather workflow fetches the linked issue (read-only `issues: read`) and the untrusted issue text is injected
only as user-turn reference data — never as trusted, precedence-taking context. A criterion the PR openly
acknowledges or defers is fine; only *silently* unmet criteria are flagged.
