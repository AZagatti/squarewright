---
description: Generic cross-language project conventions (precision-probe fixture for #73)
globs: ["**"]
---

- **Validate external input at the boundary.** Any value that comes from a request, CLI arg, file, or network
  response must be validated/parsed into a known shape before use. Flag unvalidated external data reaching logic
  or storage.
- **No debug logging in committed code.** Flag `console.log`/`print`/`fmt.Println`-style debug output left in a
  change; logging must go through the project's logger.
- **Errors are handled, never swallowed.** Flag an ignored error return, an empty catch, or a bare rethrow that
  loses context.
- **No magic numbers or hardcoded config.** Flag literal timeouts, limits, URLs, or credentials that should be
  named constants or configuration.
- **Public functions are documented.** Flag a new exported/public function or type with no doc comment.
