## What & why


## What I need from the maintainer
<!-- Concrete merge/block or yes/no questions. If none, write "Nothing — clean merge if checks pass." -->
- [ ]

## Risk summary
<!-- What in this change is risky or you're unsure about — so the reviewer knows where to look. -->

## Trust-boundary check
<!-- Skip if this PR doesn't touch gather/review workflows, secrets, permissions, or posting. -->
- [ ] Gather phase still has no secrets and never executes PR-head code
- [ ] Review phase still cross-checks the artifact's claimed head-SHA
- [ ] No permission broader than least-privilege for what the step needs

## Eval
<!-- Skip if this PR doesn't touch personas/routing, pi/worker, grounding, or output. -->
- [ ] Ran the eval on the golden corpus before & after (free z.ai, ≥3 runs, behind the spend guard)
- [ ] Recorded the delta in `eval/RESULTS.md` (or explain why N/A)
- Delta: <recall/precision before → after, or "no change expected because …">

## Subagent review status
<!-- The independent review is the gate, not the maintainer's deep read. -->
- Verdict: <APPROVE / APPROVE-WITH-NITS / REQUEST-CHANGES → resolved>
- Must-fixes found and how they were resolved:
- Squarewright dogfood review: <ran / N/A until the reviewer can post (M2+)>

## Commands run
<!-- e.g. bun run verify:pr → pass; independent subagent review → APPROVE after fixes -->
-

## Agent provenance
<!-- Delete this section if a human wrote the change by hand. -->
- Agent/tool + the task it was given:
- What the human actually reviewed vs. trusted as-is:

🤖 Generated with [Claude Code](https://claude.com/claude-code)
