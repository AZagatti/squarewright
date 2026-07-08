# Reviewer ideas scouted from cc-dcp

Source: `/home/azagatti/Projects/cc-dcp` (sibling repo, read-only scout — nothing there was modified).
That repo builds **trimwire**, an LLM proxy with a bolted-on multi-model AI PR-reviewer
(`docs/AI-REVIEW.md`, `.github/ai-review/`, `scripts/ai_review*.py`). This document is **scouted-from-cc-dcp,
adapt-not-copy** — nothing here is committed to our roadmap yet. It's raw material for a council to weigh
against `docs/NORTH_STAR.md` and `docs/ROADMAP.md` before anything gets scheduled.

Two things stand out about cc-dcp's process that make it a good source: (1) they kept **every experiment
artifact** — including negative/reversed results — in `internal/ai-review-bench/` (gitignored, not shipped,
but present in the checkout), so we can see not just what they built but what they tried and killed; (2) they
have a documented habit of **honest reversal**: a result measured on synthetic or small-N data was explicitly
re-measured on real PRs and the conclusion flipped, in writing, before anything shipped. That habit is worth
adapting on its own, independent of any specific technique below.

---

## Section 1 — Self-review / self-disagree step

The maintainer's memory was that cc-dcp's reviewer had a self-review step that reconsiders its own findings
and that it measurably helped. The honest answer, reconstructed from the bench artifacts, is: **cc-dcp tried
three different shapes of "self-review," and the one that actually shipped is not a separate reconsideration
pass at all — it's forcing the reasoning to happen before the findings are committed, in the same call.** The
two mechanisms that *were* a separate second look both failed on real data and were explicitly not shipped.
This nuance matters because it's directly relevant to our own Verifier's null result.

### 1a. What shipped: forced chain-of-thought before commit (same call, not a second pass)

`.github/ai-review/REVIEWER.md` (the production prompt, lines 21-25):

```
"_reasoning": "Think step by step here FIRST — reason about each changed section
               before committing to findings. This field is stripped before the
               review is shown; use it freely to avoid premature conclusions.",
```

This is a JSON field the model must fill *before* `findings`, in the same single call — not a second model
call, not a second pass, not a different agent. It's the "P1 / think-first" lever tracked across
`internal/ai-review-bench/PROMPT-IMPACT-2026-07-04.md` and `ISOLATION-RESULTS-2026-07-04.md`.

**Evidence, honestly tracked across N=1 → N=2 → N=4 (the numbers *changed* as N rose — that's the point):**
- N=1: looked like it doubled precision — later shown to be a lucky draw.
- N=2 isolation (5 real PRs, `ISOLATION-RESULTS-2026-07-04.md`): "P1 alone" — recall 50.4→46.0 (−4.4pp),
  precision 34.2→44.0 (+10.1pp relative, "best variant" of 6 tried).
- N=4 finalist confirmation (same file, "DEFINITIVE VERDICT" section): the robust winner across 25 swept
  conditions is **P1+P4+P5** (think-first + a per-checklist "empty findings is a valid answer" anchor + one
  worked example) — precision **+14.7pp** (roughly halves false alarms), recall **−5.2pp** (cost concentrated
  on the hardest, deepest PRs). Quote: *"Plain P1 DROPPED below baseline F1 at N=4 (recall over-cut) — the
  earlier 'P1 is best' was N=2 noise."*
- This is a real, repeatable win, not a one-off — it survived re-measurement at increasing N, which is why it
  shipped into the production `REVIEWER.md`.

**Mechanism, precisely:** it is NOT a second agent, NOT a second API call, and NOT a step that runs *after*
findings are drafted. It's a structured "think before you answer" field inside the *same* JSON schema the
model fills in one shot — closer to plain chain-of-thought prompting than to an adversarial re-check. The
field is stripped from what the maintainer sees.

### 1b. What was tried and explicitly NOT shipped: a genuine second-pass self-review

**Recall-first "re-read" nudge** (`internal/ai-review-bench/self_review_test.py`) — appends this to the
*same* system prompt used for a *second, separate* model call after the baseline call:

```python
RECALL_NUDGE = """

BEFORE FINALIZING — re-read the diff ONE more time and, for EACH checklist item
against EACH changed hunk, ask "did I miss a genuine issue here?" ADD every real
issue you find on this second look. A missed real issue is the WORST outcome; do
NOT remove or soften findings in this pass — completeness only."""
```

Note the design: deliberately recall-only in this direction (find more, never prune) — "that order is
deliberate: recall first, review second" (docstring, line 22). Judged against 30 planted-bug cases
(`selfreview_judged.json`): only **1 case flipped false→true** (a catch gained) and **1 case flipped
true→false** (a catch lost) — net **zero**. `docs/OVERNIGHT-REPORT-2026-07-04.md` §1 later confirms this
lever "measured NULL (tested, honestly discarded — did not ship)" under the label `self-review "double-shot"
pass`.

**Conservative refuter / "verify" pass** (`internal/ai-review-bench/verify_test.py`) — this is the one that
most resembles our Verifier: a **separate, cross-model call** (finder uses one lane, refuter is pinned to a
different lineage — `REFUTER = pz.LANES["deepseek"]`, "capable, cheap, DIFFERENT lineage from most persona
lanes") that reviews the *finder's own findings* against the diff and returns keep/drop verdicts:

```python
REFUTE_SYS = """You verify code-review findings to remove NON-DEFECTS — one pass, recall-first.
...
ALWAYS refute (refuted=true) — these are NOT real findings:
- SELF-NEGATING: the finding's own text concludes there is no problem ("no issue", "it's fine", ...).
- POSITIVE ASSESSMENTS / non-findings: "no public API changes", "changelog is descriptive", ...
- PURE STYLE/NITPICK with no concrete defect or exploit path.
- SPECULATIVE with no mechanism: "could potentially" / "might" with no concrete code path in the diff.

KEEP (refuted=false): anything describing a CONCRETE potential defect ... even if
you're uncertain it fires. Dropping a real finding is worse than keeping a marginal one."""
```

**This is where the honest-reversal habit shows up.** Two rounds of measurement, in order:

1. **Small-N / partly-synthetic round** (`verify_judged.json`, 3 real PRs): conservative refuter pruned 19 of
   124 findings (15.3%), **zero ground-truth findings lost**, precision 7.3%→8.6% (**+18% relative**).
   Verdict at the time: *"Safe to ship as a recall-preserving filter but not yet effective as a precision
   multiplier."* An **aggressive** variant of the same refuter (`verify2_judged.json`) pruned 61% of findings,
   raised precision 7%→17%, but **lost 1 real ground-truth finding** (a broken `pytest.mark.parametrize` that
   got misread as a naming nitpick) — logged as `"crossed_line": true`.
2. **N=5 real-PR round, run later** (`docs/OVERNIGHT-REPORT-2026-07-04.md` §3, the definitive one): the same
   conservative refuter, re-run over 5 *different*, larger real PRs (deno, polars, delta-rs, lance×2), **caused
   net harm on 4 of 5** — recall collapsed from e.g. 8/9→1/9 on deno, 2/5→0/5 on lance twice. Quote: *"4/5 net
   harm — it destroyed 71% of real catches (12 of 17). Smoking gun: on lance#7608 the refuter re-described the
   real MockClock race as 'order-dependent global state' — understood it — then dropped it."* Inverting the
   refuter to be maximally conservative (keep unless verbatim-contradicted by a diff line) made it safe but
   **inert** — 5 drops total across all 5 PRs, "a tiny sliver of the real noise."

**Final verdict, verbatim** (`OVERNIGHT-REPORT-2026-07-04.md`, §3 and the `PROMPT-IMPACT`/`DECISION-157` docs
agree): *"a single-model verify pass is architecturally broken for this task — a model can't reliably refute
its own output by re-reading the same diff. Aggressive over-drops; timid under-drops... Don't ship either."*
`docs/research/../DECISION-157-direction-2026-07-05.md` generalizes it into a standing rule: *"Rejected-and-
confirmed-dead levers (don't re-propose): ... naive adversarial refuters (aggressive = −71% recall)... The
failure mode: resampling the same model with no new information channel."* Their prescribed fix for the
*future* is not a text re-read but an **execution-gated verifier** that "must re-run the deterministic check
to confirm a hypothesis... never a text re-read (this is what encodes the −71% refuter lesson)."

### Reconciling this with our own Verifier (`src/pi/verifier.ts`)

Our Verifier already goes one step further than cc-dcp's failed mechanism — it's cross-agent (a separate Pi
session) *and* execution-grounded (real shell, told to empirically test claims, not just re-read). That's
closer to what cc-dcp's own `DECISION-157` doc says should work ("execution-gated... never a text re-read")
than to the text-only refuter that produced −71% recall for them. Yet we measured ~0 precision gain at ~2×
wall-time on our clean free model. Two honest readings, not mutually exclusive: (a) our corpus may not contain
enough *plausible-but-wrong* findings for a refuter to have anything real to cut (cc-dcp's −71% case was on
noisy, deep, multi-domain real PRs with 15-58 raw findings per PR; ours may be cleaner going in), or (b) even
execution grounding doesn't fully solve the "can't refute your own blind spot" problem cc-dcp diagnosed,
because the underlying claim being refuted still came from a model reading the same diff. Both cc-dcp's
result and ours point the same direction: **don't invest further in a same-model/adjacent-model text-refuter
shape; if a verifier is worth keeping, it should stay execution-grounded and probably needs a corpus with more
real noise in it before its value is measurable at all.**

The one shape that *did* show a real, repeated, honestly-reversed-and-confirmed gain — forced reasoning before
committing to findings, same call, no second agent — is something our two-pass Worker already does in an even
more disciplined form (see `src/pi/worker.ts`'s pass-1 free-form-prose-reasoning → pass-2 fixed-extractor
split, which exists for exactly the same underlying reason: "reasoning models frequently reason and then never
call the tool... it also suppresses free-form reasoning"). This is corroborating evidence for a design we
already made, not a new idea to adopt — worth noting as validation rather than a gap.

---

## Section 2 — Other adaptable ideas (ranked by likely value to us)

### 2.1 Correlated-pair batching cap (max 2 personas/call, correlated-first)

**(a) What it is.** Rather than "one call per persona" or "compose everything that fires into one call,"
cc-dcp caps composed calls at 2 personas, preferring to pair personas from the same domain cluster:

```python
# scripts/ai_review_personas.py
_CLUSTER = {"SENTINEL": "correctness", "FERRUS": "correctness", ..., "WARDEN": "security", ...}

def group_correlated_pairs(modules: list[dict]) -> list[list[dict]]:
    """Pair CORRELATED personas on the same resolved model, MAX 2 per call. ... A module
    marked `solo` ... is pulled out first into its OWN single-module call and never paired."""
    out = [[m] for m in modules if m.get("solo")]
    rest = [m for m in modules if not m.get("solo")]
    for ms in group_by_model(rest).values():
        ms = sorted(ms, key=lambda m: (_CLUSTER.get(m["name"], "z"), m["name"]))
        for i in range(0, len(ms), 2):
            out.append(ms[i:i + 2])
    return out
```

**(b) Evidence.** `docs/OVERNIGHT-REPORT-2026-07-04.md` §2, N=5 real multi-domain PRs, judged: max-2 has the
highest **mean** recall (68.8%) and precision (45.2%) of {generalist, composed-all, max-2, per-persona}, and
is best-or-tied on recall in 4/5. Concretely on deno#35737 (9 GT issues): per-persona 56%/83%, full-composed
44%/67%, **max-2 89%/92%** (dominates both axes, plus 3 solo catches). But it's **honestly characterized as
not a strict dominator**: on lance#7512 max-2 lost to full-composed (40%/9.1% vs 60%/15%) because "the max-2
constraint paired correlated personas too tightly, so they reinforced each other's blind spots instead of
giving independent signal" — a named, real failure mode, not swept under the rug.

**(c) Mapping to our architecture.** `src/personas/defaults.ts` already has the building blocks — `solo`,
explicit `pass` grouping (Docker+CI already batch this way), and a shared "baseline" pass for everything else
(see `passGroup()`). Today our default is "batch ALL non-solo personas that fire into one shared baseline
pass" (uncapped), which is the "full-composed" arm cc-dcp measured as weaker than max-2 on both axes for
deep/multi-domain PRs. The adaptable idea: cap the baseline batch at ≤2 (or N, tune it), grouped by a domain
cluster similar to `_CLUSTER`, instead of one unbounded batch.

**(d) North-Star fit.** Directly measurable on our golden corpus — it's a same-shape recall/precision/finding-
count comparison we can already run (composed vs. capped-composed vs. per-persona) with our existing eval
harness. Low overclaim risk if we report it the way cc-dcp did: as a mean-with-a-named-exception, not a
blanket "always better."

### 2.2 Deterministic dedup by title-token overlap (no LLM aggregator call)

**(a) What it is.** Two findings are merged as "the same issue" using a cheap, explainable rule — not an LLM
judgment call:

```python
def _same_issue(f: dict, g: dict) -> bool:
    if f.get("file", "") != g.get("file", ""): return False
    lf, lg = f.get("line"), g.get("line")
    if isinstance(lf, int) and isinstance(lg, int) and abs(lf - lg) > 3: return False
    if _norm(f.get("title", "")) == _norm(g.get("title", "")): return True
    return _overlap(_title_tokens(f.get("title","")), _title_tokens(g.get("title",""))) >= 0.85
```

with `_overlap` = intersection / min-size (an *overlap coefficient*, chosen specifically because it's "robust
to one title being a longer restatement of the other, which is exactly how two personas reword the same
bug"), and a deliberately high 0.85 threshold documented with a worked counter-example (`T: Send` vs `T: Sync`
overlap ~0.67 and correctly stay separate). `scripts/ai_review_personas.py:349-376`.

**(b) Evidence.** `docs/AI-REVIEW.md`: "Findings are then deduplicated deterministically ... — no paid LLM
aggregator, no recall leak." `docs/OVERNIGHT-REPORT-2026-07-04.md` §4 credits `_collapse_repeats` +
`aggregate()` as what "handles the dominant noise source (cross-file repetition) deterministically, no model
call" and explicitly prefers this over any model-based verify/dedup step.

**(c) Mapping to our architecture.** `src/output/` already owns "dedup/aggregation" per the module table in
`docs/ROADMAP.md` — this is likely already partially built. Worth a direct comparison of our current
similarity metric against the overlap-coefficient-with-line-window approach and its documented threshold
tuning story (0.85, with the `Send`/`Sync` near-miss as a regression case).

**(d) North-Star fit.** Purely deterministic, cheap to test in isolation on synthetic paired-duplicate cases
before touching the golden corpus — very low overclaim risk, and a good `Send`/`Sync`-style adversarial test
case to add to our own suite regardless of whether we change the metric.

### 2.3 Checklist-grounded personas + cost-tiered model lanes ("the checklist beats the model")

**(a) What it is.** Personas are framed as **standards-grounded checklists** (CWE Top 25, WCAG 2.2, Rust API
Guidelines, GHA hardening, web.dev Core Web Vitals) rather than free-form "act as a security expert" prompts,
and the model assigned to each persona is chosen by measured fit, not uniform strength — cheap models on
checklist-carried personas, a stronger/pricier model only where the checklist doesn't carry it (WARDEN/GPT-5-
mini in their panel). `docs/AI-REVIEW.md`: *"tuning the accessibility checklist lifted a $0.0019 model from
0.60 to 1.00 recall and replaced GPT-5-mini. The knowledge lives in the checklist, so the model can be
cheap."*

**(b) Evidence.** A 67-case real-fix-PR classification bench, blinded-judge scored, per `docs/AI-REVIEW.md`;
`RESULTS-classification.md` and `PERSONA-ROSTER-PROPOSAL.md` in the bench dir hold the underlying numbers if
we want to verify further.

**(c) Mapping to our architecture.** `src/personas/defaults.ts` + `ModelLane` already support per-persona
model assignment. The adaptable piece is the *practice*: when a persona underperforms, tune the checklist
text first (cheap, fast iteration) before reaching for a stronger/pricier model.

**(d) North-Star fit.** Directly measurable — it's exactly the kind of before/after recall comparison our
golden corpus is for. Low overclaim risk as long as we report it per-persona, not as a global claim.

### 2.4 Calibration discipline baked into the prompt: silence is a valid answer

**(a) What it is.** `.github/ai-review/REVIEWER.md`: *"An empty `findings` array with `'verdict': 'approve'`
is the correct, expected result for a clean PR. Producing a finding you're not confident about is the worst
outcome."* Plus explicit defer-to-tooling: *"Don't flag anything a formatter/linter already handles... If CI
results are provided in context, defer to them."* And explicit truncation-awareness: budget-truncated diffs
are marked with `[truncated for length — NOT a code defect]` and the model is told never to report the
truncation marker itself as a finding.

**(b) Evidence.** This is qualitative/prompt-design rather than a standalone measured lever, but it's the
`P4`/"per-checklist anchor" component that was *part of* the confirmed-winning N=4 prompt stack (§1a above) —
so it has indirect measured support as part of that bundle, not in isolation.

**(c) Mapping to our architecture.** Worth an audit of our persona prompts (`src/personas/defaults.ts`) and
Worker prompt (`src/pi/worker.ts`) for whether "empty findings is correct and expected" and "never flag
truncation as a defect" are stated as explicitly and forcefully as cc-dcp's version.

**(d) North-Star fit.** Cheap to add, hard to measure in isolation (it's calibration, so its effect shows up
as fewer false positives on clean/near-clean PRs in the corpus, if we have those cases) — low risk, worth
doing regardless of measurement.

### 2.5 Consensus-gated low-noise display mode

**(a) What it is.** An opt-in label (`ai-review-strict`) that hides single-model findings from the visible
comment (they stay in a collapsed raw section) unless ≥2 models independently agree — except security
findings, which always show regardless of consensus. `docs/AI-REVIEW.md`: *"the sticky comment shows only
findings ≥ 2 models agree on (security findings are always shown; hidden solo findings remain in the
collapsed raw-panel section)."*

**(b) Evidence.** Framed as a cost/noise control, not separately benchmarked in the docs we found — but it
composes with the `consensus` count that `aggregate()` already computes as a side effect of dedup (§2.2), so
it's nearly free once dedup exists.

**(c) Mapping to our architecture.** We already have multiple personas potentially finding the same issue;
if `src/output/` tracks a consensus count per finding (from dedup), this is a rendering-layer toggle, not a
new pipeline stage.

**(d) North-Star fit.** Easy to measure precision/recall trade-off on the corpus (it's a filter on already-
collected findings) and it's opt-in, which fits our "no overclaiming, user controls the dial" posture.

### 2.6 Self-improving rule memory, human-gated

**(a) What it is.** `.review-rules/` is a committed, path-scoped "memory" the reviewer loads per PR
(`_manifest.toml` maps globs → persona + rule file). The AI can *propose* new rules via an optional
`rule_suggestions` field in its own JSON output (`{category, glob, rule, why}`), but never writes them
directly: *"A weekly job (`ai-review-track.yml`) mines the bot's inline-comment threads for maintainer signals
... publishes per-persona acceptance rates... Over time this shows which personas are noisy, so their
checklists can be tightened."* And separately, `.review-rules/README.md`: *"The `ai-review-rules` maintenance
workflow collects accepted suggestions and opens a small PR... A human merges it... Why human-gated: rule
text goes straight into the model's prompt, so an auto-committed rule is a prompt-injection vector."*

**(b) Evidence.** Described as a process, not independently benchmarked — the acceptance-rate tracking is the
measurement instrument for it, not proof it improves anything yet.

**(c) Mapping to our architecture.** This maps almost exactly onto our already-stubbed `feedback/` module
("Signal capture (reactions + implicit) and local tuning proposals" per `docs/ROADMAP.md`'s module table) —
cc-dcp's concrete implementation (glob-scoped rule files + AI-proposed additions + human-gated PR merge, never
auto-committed because rule text becomes prompt content) is a validated recipe we can crib the shape of
without needing to invent our own from scratch.

**(d) North-Star fit.** The acceptance-rate side is directly measurable (thumbs up/down, "good catch" replies)
and inherently self-correcting rather than a one-time claim — good fit. The security rationale (rule text is
a prompt-injection surface, never auto-commit) is a hard constraint we should keep regardless.

### 2.7 SURVEYOR: a structured, solo, two-step "enumerate then check" pass for structural recall gaps

**(a) What it is.** A dedicated persona, always-on, never batched with anything else (`solo=True`), whose
prompt is two explicit steps rather than one open-ended review: *"STEP 1 enumerate every changed public
symbol / new branch / modified-or-removed test; STEP 2 rule coverage per item, emit severity='test' finding
only for a real gap (untested symbol/branch, coverage REGRESSION from '-' lines, FALSE coverage = local/mock
path named as a real feature). Grounded-line requirement for 0-FP."* (`SURVEYOR-impl-notes-2026-07-04.md`).

**(b) Evidence.** Tested against a cluster of real issues that *every other setup missed* on the N=5 real-PR
round (coverage regressions, untested new branches, tests that "pass" against a mock that ignores the feature
under test, renamed test helpers) — `docs/OVERNIGHT-REPORT-2026-07-04.md` §5. The enumeration pre-pass caught
1 of 4 target misses with **0 false positives across 8 findings**; a plain strengthened-checklist attempt at
the same problem scored 0/4 ("structural, not a checklist problem"). Explicitly framed as probabilistic (GLM
is non-deterministic, catches the hard case "~1/3 of runs") but *never wrong when it does fire* — "no FPs
observed."

**(c) Mapping to our architecture.** This is a persona-design pattern (force enumerate-then-judge as two
explicit steps, keep it un-batched to avoid dilution) rather than an infra change — directly usable as a new
persona or a restructuring of an existing test-coverage-focused persona in `src/personas/defaults.ts`.

**(d) North-Star fit.** Directly measurable — it's a targeted persona whose hit rate on a known miss-class can
be tracked on the corpus, and its own docs already model the honest framing we want ("probabilistic,
zero-FP-so-far, first shippable version" — not "solves coverage review").

### 2.8 Multi-sample voting: a documented dead end (useful as a guardrail, not an idea to adopt)

**(a) What it is.** Sample the same model N times at different temperatures and union findings across samples
(`AI_REVIEW_SAMPLES` env var in production, off by default).

**(b) Evidence.** `docs/AI-REVIEW.md`: *"on our own planted-bug corpus... this gave 0 pp recall for ~2.8× the
findings — the extra passes just reproduce the same hits. It only helps on large, multi-file PRs where one
pass under-samples the diff."* `docs/OVERNIGHT-REPORT-2026-07-04.md` lists "multi-sample voting (0pp)" among
confirmed-dead levers project-wide.

**(c)/(d)** Not something to adopt — but worth citing as a second independent confirmation (alongside our own
Verifier's null result) that "resampling the same model with no new information channel" is a broadly dead
lever, not something specific to how we built our Verifier. Good ammunition for not re-litigating that
direction internally.

---

## Section 3 — Open questions / what to measure

If a council decides any of the above is worth scheduling, here's what an honest measurement pass would need,
per idea:

1. **Correlated-pair batching cap (2.1).** Run our existing golden corpus through {current unbounded-baseline
   batching} vs {capped-at-2, correlated-first grouping} and report recall/precision/finding-count as a
   distribution, not a single number — cc-dcp's own result had a real, named exception (lance#7512) and we
   should expect and report ours too, in ranges, per our North Star.
2. **Dedup metric (2.2).** Before touching the corpus: construct a small adversarial set of near-duplicate and
   near-miss title pairs (including a `Send`/`Sync`-style true-negative) and check our current dedup against
   cc-dcp's overlap-coefficient-with-line-window approach on that set first — cheap, no LLM spend needed.
3. **Checklist tuning (2.3).** Pick one currently-weak persona, tune only its checklist text (no model
   swap), and re-run on the corpus. This is the cheapest possible test of the idea and mirrors exactly how
   cc-dcp validated it.
4. **Calibration prompt language (2.4).** Hard to isolate numerically; treat as a prompt-quality audit rather
   than a corpus experiment, but log clean-PR (no planted bug) false-positive rate before/after if we have
   clean cases in the corpus.
5. **Consensus-gated display (2.5).** Purely a post-hoc filter on already-collected findings — replay existing
   eval-run output through a "hide if consensus<2 and not security" filter and report the precision/recall
   delta. No new LLM calls needed to test this.
6. **Rule memory (2.6).** Not really a golden-corpus metric — the honest measurement here is operational
   (acceptance-rate over real review threads over time), so it only becomes measurable once we're dogfooding
   on real PRs, not before. Flag as "defer measurement until post-dogfood," not "unmeasurable."
7. **SURVEYOR-style enumerate-then-check persona (2.7).** Needs a small labeled slice of the corpus with
   known coverage-regression / false-coverage / untested-branch cases (cc-dcp's structural-miss class) — if
   our corpus doesn't have that case type yet, that's itself worth noting, since cc-dcp found it was a miss
   class *every* setup shared, which suggests it's common enough to be worth deliberately seeding into ours.
8. **The self-review reconciliation (Section 1).** The one concrete thing worth doing here is *not* re-testing
   a text-only refuter (both cc-dcp and we already have converging null/negative evidence) — it's checking
   whether our Verifier's ~0 result changes on a noisier corpus slice (more real, ambiguous, multi-file PRs,
   fewer clean ones), since cc-dcp's own refuter only showed its failure mode on exactly that kind of PR. If
   we don't have that kind of case in the golden corpus yet, the honest conclusion is "not yet measured on the
   PR shape where it would matter," not "the Verifier doesn't help."

All file paths cited above are under `/home/azagatti/Projects/cc-dcp` (read-only reference) — re-check them
directly if a claim needs re-verification before being acted on.
