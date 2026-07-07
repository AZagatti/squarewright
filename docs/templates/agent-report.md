# Agent report template

How an agent reports finished work to the maintainer — in chat and as the shape of a PR body. Write for an
orchestrator who is **not** reading the diff line by line: plain, technical-but-not-dense English. **Explain
any project shorthand the first time you use it** (e.g. "M1 — the roadmap milestone that makes the review
engine reachable from the CLI"; a `§` section reference; a persona/brick name). If a term needs a footnote to
be understood, define it inline instead.

Keep it short. Lead with what changed and whether the maintainer needs to do anything.

```
## What changed
Plain-English summary of the change and what it's for. One short paragraph, no jargon left undefined.

## Risk summary
What could go wrong, what you were unsure about, and where a reviewer's attention is best spent. "Low —
pure logic, fully tested" is a fine answer when true.

## Review
The independent reviewer's verdict and how any must-fixes were resolved. If the review looped
(fix → re-review), say so.

## Checks / CI
What you ran and the result: `bun run verify:pr` (typecheck + tests + lint), CI status, any eval numbers.

## Maintainer input
Either a crisp merge/block or yes/no question the maintainer must answer, **or** the exact line:
"No maintainer decision beyond merge/block."
```

Notes:
- The `.github/PULL_REQUEST_TEMPLATE.md` covers the PR body's full checklist (trust-boundary, eval, provenance);
  this template is the shorter narrative report — the two agree, they don't duplicate.
- Estimate scope by **complexity, not time** (files touched, surface area of behavior change, whether it needs
  eval/benchmarking) — never "a quick fix" or "a day's work".
