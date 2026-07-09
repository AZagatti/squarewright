# Review rules memory

Repo-specific conventions Squarewright feeds to the reviewer as **trusted project context**. Keep them tight
and factual — they go straight into the model's prompt.

## How it works

- Add markdown files here with short, concrete conventions (one bullet per rule).
- Rules can be scoped by file globs so the reviewer only sees rules relevant to the changed files.
- Rule text is injected as trusted context, so **rules are only added by maintainers via a reviewed change**
  — never auto-committed by the tool (an auto-committed rule would be a prompt-injection vector). When the
  reviewer proposes a new rule, it posts the rule text as a suggestion for a maintainer to paste into a file
  here — it does not open a PR or write the file itself.

## Example

```md
---
description: Core architecture rules
globs: ["src/**"]
---

- `src/strategies/*` must be pure: no I/O, no globals.
- Only `src/ledger.ts` may touch the database.
- Public API changes require a changelog entry.
```

This starter file is safe to edit or delete. See docs/design/feedback-and-data.md for the learning loop.
