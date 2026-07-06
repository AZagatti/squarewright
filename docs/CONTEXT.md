# CONTEXT — glossary (ubiquitous language)

> Glossary only. No implementation details, no decisions (those live in `docs/adr/`).
> Center of gravity per [ADR-0001](adr/0001-pi-centered-reviewer-assembly.md): the **Worker (Pi)** is the
> spine; **Grounder / Verifier / Policy** are *optional* pieces that feed or check the AI.

- **Squarewright** — the toolbox for assembling a repo-local AI code reviewer on top of Pi.
- **Pi** — the borrowed agent runtime ([earendil-works/pi](https://github.com/earendil-works/pi)): agent
  loop, tool-calling, sessions, provider abstraction, native-binary distribution. Squarewright does not
  rebuild any of this.
- **Assembly** — a user's wired-up reviewer: the `.squarewright.yml` config + personas + rules + tools that,
  together with Pi, review a PR.
- **Preset** — a ready-made Assembly for a common case (e.g. the GitHub Action preset scaffolded by `init`).
- **Brick** — a composable unit of an Assembly. Some ship ready-made; users can write their own.
- **Brick kinds:**
  - **Worker** — an LLM (any provider, via Pi) that reasons over a change with Tools. **The spine.**
  - **Persona** — a named checklist/lens a Worker applies (security, correctness, accessibility, …).
  - **Router** — maps changed files → which Personas apply (glob-based), plus pairing/batching policy.
  - **Tool** — a capability the Worker can call (repo-inspect, ci-signal, post-comment); registered into Pi.
  - **Grounder** *(optional)* — produces *facts* about a change (changed symbols, call-graph, coverage-diff,
    linter/CI output). No LLM. Feeds the Worker as context or a Tool result.
  - **Verifier** *(optional)* — confirms a candidate finding by invoking a Tool (compile/test/grep). Never a
    text re-read.
  - **Policy** *(optional)* — a declarative deterministic rule over the change-set ("files A changed ∧ docs B
    unchanged → finding"). No LLM.
  - **Poster** — emits findings to GitHub as a **sticky summary + inline comments**. Owned by Squarewright
    (correct diff-line mapping, dedup, markdown-injection safety) — not merely delegated.
- **Finding** — a single review result `{file, line, rule, severity, message, evidence?, suggestion?}`.
- **Rules memory** — repo-specific review conventions (`.review-rules/` or equivalent) injected into the
  Worker's prompt as trusted project context; can grow via human-gated learning.
- **Model lane** — a named `(provider, model, reasoning-knob)` target a Persona routes to (cheap vs. peak).
- **Feedback signal** — explicit (👍/👎, replies) or implicit (line changed later, suggestion accepted) data
  used to self-tune reviews. See [`design/feedback-and-data.md`](design/feedback-and-data.md).
- **Grounded** — a finding backed by a fact (Grounder/Policy) or an observation (Verifier), not just an LLM
  assertion.
- **Honest measurement** — reporting real-PR recall/precision on big, ambiguous PRs from real repos,
  separately from synthetic; refusing a single blended headline number.
- **Corpus / Judge** — a labeled set of real PRs + a scorer, used to measure the *assembled reviewer* (not a
  standalone finder).
