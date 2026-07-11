# Setup-development results

> **⚠️ Correction (2026-07-06, later): the numbers below were measured on a BROKEN harness and an inflating
> metric — treat them as superseded.** A four-angle investigation found: (1) a **silent tool-drop bug** — the
> worker returned empty findings (scored as "clean") when the model reasoned but never called the tool, worse
> at higher reasoning effort; (2) **file-level scoring over-credits** — a finding on the right *file* counted as
> a hit even if it described a different bug. Both are now fixed: the worker is **two-pass** (reason → structure)
> so it can't silently drop, and a **defect-match judge** (`scripts/judge.ts`) scores real root-cause matches.
> On the same personas-off run, the judge corrected **file-recall 5/12 → defect-recall 3/12** (~25%, in line
> with trimwire's ~27% reality). Also: Pi's reported `usage.cost` is unreliable (often left at 0/unpopulated), so real
> spend is read from OpenRouter's credits balance instead. (Correction 2026-07-09: the token *count* `usage.output` DOES
> include reasoning tokens — `openai-completions.js:917` — so this is a cost-field-population issue, not a reasoning-token
> undercount; earlier phrasing here overstated it.) Re-runs on the fixed harness are the real numbers; the table below is
> kept only as the record of what led to the fixes.

Measurements from tuning the review *setup* against the golden corpus (not a model ranking — that comes once
the setup is locked). All runs: `glm-5.2` via z.ai, grounded (repo read at PR revision). Scoring is loci-level
(a finding on an expected-locus file counts as a hit) — deliberately simple; a judge pass is a later refinement.

## Setup progression (18 clean+has-issue; recall over 12 has-issue loci)

| Config | Locus recall | Clean false-positives | Relative speed |
|---|---|---|---|
| Generic persona, thinking off | 3/12 | 2 | 1× |
| Generic persona, thinking high | 4/12 | — | ~10× |
| **Persona set, thinking off** | **5/12** | 2 | 1× |
| Persona set + as-designed thinking | 5/12 | — | ~2.5× |

## Findings

1. **Personas are the lever, not thinking.** The persona set (2 always-on batched: sentinel/correctness +
   warden/security; 4 glob-triggered solos: chromatic/CSS, foreman/build-config, stevedore/Docker, marshal/CI)
   lifted recall 3/12 → 5/12 with **no extra false positives and no speed cost**. It recovered tokio (1/2→2/2,
   lock-ordering) and grafana (0/1→1/1, Docker build-stage ownership) — exactly the personas' design targets.
2. **Thinking is not worth it here.** thinking-high on the generic persona reached only 4/12 at ~10× latency;
   personas + thinking merely *shuffled* which cases hit (gained tailwind/go-cli, lost tokio/moby) at ~2.5×
   latency — variance, not a reliable gain.
3. **The stubborn misses are model-bound.** vite (`fs.cpSync` Windows/​symlink defaults), rails (schema-cache
   sort → query order change), and swup (tsconfig change → dropped published `.d.ts`) are missed under *every*
   config even when a persona cues them — pointing at glm-5.2's reasoning ceiling, not the setup.

## Operating point

**Persona set, thinking off, grounded** — 5/12 loci (~42%) / 5-of-9 has-issue cases with ≥1 hit (~56%), 2
clean false-positives, fast. For context, trimwire's 67-case bench put real ambiguous-PR recall at ~27%.

## Next

- Add the adversarial **verifier** pass to clear the 2 clean-case false positives (precision).
- The remaining gap looks model-capability-bound → the setup is near "good enough to rank": run the
  cheap-vs-expensive-5-family model comparison on this locked persona+grounding setup.

---

# Initial model rank — 2026-07-07

**State of the project when measured:** two-pass worker (analysis → structurer), persona set, **no grounding**,
`--thinking off`, scored by a **Claude subagent** on real defect-match (not the inflating file metric). This is
an INITIAL, rough rank of *cheap* models — precision (noise) is the clear bottleneck; the "good" quality ceiling
(expensive 5-family models) is untested (OpenRouter budget exhausted twice by reasoning-token burns — see the
guardrail + circuit-breaker now in `scripts/eval.ts`).

Real defect-recall over 12 has-issue loci; noise = off-target findings; cost = real OpenRouter spend (credits delta):

| model | provider | defect-recall | noise | real cost | structurer |
|---|---|---|---|---|---|
| deepseek-v4-flash | OpenRouter | 5/12 | ~34 | $0.96 (forced reasoning) | qwen3-coder-30b |
| **glm-5-turbo** | z.ai | **3/12** | **~1** | free | glm-5-turbo |
| deepseek-v3.2 | OpenRouter | 2/12 | ~24 | $0.077 | qwen3-coder-30b |
| glm-5.2 | z.ai | 2/12 | ~14 | free | qwen3-coder-30b |
| glm-5.1 | z.ai | 2/12 | ~7 | free | glm-5-turbo |
| glm-4.5-air | z.ai | 2/12 | ~14 | free | glm-5-turbo |
| glm-4.7 | z.ai | 1/12 | ~15 | free | glm-5-turbo |
| xiaomi/mimo-v2.5 | OpenRouter | 1/12 | ~11 | $6.6 (forced reasoning) | qwen3-coder-30b |

**Reads:**
- **glm-5-turbo (free) is the value pick** — best precision (~1 noise) with solid recall (3/12 ≈ 25%, matching
  trimwire's ~27% reality). Our default dev model.
- **deepseek-v4-flash** tops recall (5/12) but at $0.96/run (forced reasoning) and ~34 noise — not viable as-is.
- Model choice moves recall only within a narrow 1–5/12 band. **Precision is the lever**, and it's controllable
  without a bigger model. Noise tracked with the structurer (glm-5-turbo structurer ~1 vs qwen3-coder ~24–34) —
  **BUT that comparison is confounded** (2026-07-09): the low-noise glm-5-turbo-structurer rows also used z.ai
  *analysis* models, and the qwen-structurer rows used noisier OpenRouter analysis models. No same-analysis-model,
  swap-only-the-structurer comparison exists, so "the structurer dominates noise" is not established.
- The **file metric inflated recall ~2–4×** vs the Claude judge — always judge on defect-match.

**Caveats:** single run each (variance), 12 loci (small), no grounding, mixed structurers (a confound — the
z.ai rows used the glm-5-turbo structurer). Treat as directional, not final. Improvements (below) are tested
against these numbers.

---

# Measurement-first pass — 2026-07-07 (grounding + run-to-run variance)

The initial rank used single runs; three unbiased critics flagged that (1) we hadn't measured run-to-run
variance at `thinking off`, and (2) `--ground` and `--verify` were never measured before being trusted. This
pass measures both on the value pick (**glm-5-turbo**, personas, `thinking off`, glm-5-turbo structurer,
z.ai). All findings here are **metric-independent** (they hold on the crude file metric; the Claude
defect-judge would only refine the recall digit, not the direction).

## Run-to-run variance is large (noise floor)

Three runs of the **identical** ungrounded config:

| run | file-hits / 12 | clean false-pos / 9 |
|---|---|---|
| A | 3 | 0 |
| B | 1 | 1 |
| C | 1 | 0 |

Recall swings 1→3 across identical runs. **The "3/12" in the initial rank is the top of the range, not the
median (~1/12).** Consequence: single-run per-model numbers are directional only — real comparisons need ≥3
runs (or many more loci). Precision is stable (0–1 FP) when ungrounded.

## Grounding (free repo read, as first wired) HURT — precision collapse

One grounded run of the same config: **file-hits 2/12 (no gain), clean false-positives 7/9 (from 0–1).**
Handing the model `read_repo_file`/`list_repo_dir` with no scope discipline made it review the *repository's
pre-existing state* instead of the *PR's change*. Concretely, on the clean `ci-astro-16713` PR it emitted 6
findings — all out-of-scope: "this *other* workflow lacks `persist-credentials: false`", "pre-existing dead
code", "`label.yml` not included in this hardening pass". Real observations, wrong job: none are introduced
by the diff.

**Attempted fix:** tightened `GROUNDING_NOTE` (src/pi/worker.ts) — grounding tools may only VERIFY issues the
diff introduces or directly triggers; explicitly forbid reporting pre-existing problems or "this other file
should also be fixed" in untouched code. Re-run of the same grounded config after the fix:
**clean false-positives 7/9 → 2/9 (precision restored), but file-hits 2 → 0/12** — the model emitted just **1
finding across all 9 has-issue cases.** The scope note over-suppressed this weak free model: it clammed up
rather than reporting selectively.

**Verdict: grounding fails glm-5-turbo both ways** — free repo-read collapses precision (7 FP), scope-disciplined
repo-read collapses recall (~0 findings). Neither beats ungrounded (1–3 hits, 0–1 FP). We keep the scoped
`GROUNDING_NOTE` because the guardrail is *correct in principle* (a PR reviewer should only flag diff-introduced
issues, never hunt the repo's pre-existing state) and it **only affects the grounded path, which is off by
default** — so it can't regress the operating point. Revisit grounding when testing a stronger analysis model
that can stay selective under scope discipline instead of going silent.

## Operating point (updated)

- **Default grounding OFF.** Free grounding cost +6 clean-case false positives for zero recall gain; scoped
  grounding zeroed recall on this model. Ungrounded (1–3 hits, 0–1 FP) is the best balance for glm-5-turbo.
- **Precision, not recall, remains the lever** — and grounding is a precision *liability* on weak models.
- **Report ranges, not points.** Bench single-runs understate variance; treat any single recall number as ±2.
- **`--verify` measured (2026-07-07), OFF by default.** One verify-on run of the value pick (glm-5-turbo,
  ungrounded): clean false-positives held at 0/9, recall 1/12 (in the 1–3 variance band). It worked
  mechanically — on `python-requests` it pruned raw 4 → 1 confirmed while *keeping* the real hit — but
  glm-5-turbo ungrounded is already clean, so verify bought ~0 precision at **~2× wall time with a bad tail**
  (per-finding passes serialize within a case; one case took 28 min). Keep it OFF by default; reach for it
  only on a *noisy* model (where there's real noise to prune) rather than the already-clean value pick.

## First multi-run range — `eval --repeat 3`, glm-5-turbo (2026-07-08)

The eval now runs N passes per config (`--repeat N`) and reports **ranges**, not a single number — the harness's
own run-to-run variance made every prior point estimate unfalsifiable (this doc already warned "treat any single
recall number as ±2"). First honest 3-run measurement of the value pick (glm-5-turbo free analysis + glm-5-turbo
structurer, personas on, thinking off, ungrounded), 12 loci / 9 clean cases, free z.ai:

- **locus recall: 1–2/12 (median 1)** — the three runs scored 1, 2, 1.
- **false positives (raw): 0–3 (median 2)** — the three runs scored 0, 3, 2.

The range corrects an over-optimistic single-run figure: the **FP median (2) is higher than the "0–1 FP"** number
above, which came from one lucky run; recall sits at the low end of the prior "1–3" band. So glm-5-turbo's "clean"
reputation is softer once replicated, and the recall/precision tradeoff is noisier than any single run showed —
exactly why the North Star refuses a single flattering number. From here, every quality comparison (model ranking,
M5 batching) must be **range-vs-range over ≥3 runs**, which `--repeat` now makes first-class.

## M5 batching intensity — `eval --batching split|current|batched`, glm-5-turbo (2026-07-08)

Added `--batching split|current|batched` to the eval (persisted to `runs.jsonl` so runs are auditable by mode) and
ran all three at `--repeat 3` on the 18-case corpus (12 loci / 9 clean), free z.ai, `thinking off`:

| mode | grouping | locus recall /12 (range, median) | clean false-positives (range, median) |
|---|---|---|---|
| **split** | every lens its own call | 2–3 (median 2) | 2–3 (median 2) |
| **current** | correctness+security batched, domains solo | 0–1 (median 0) | 0–4 (median 2) |
| **batched** | ALL fired lenses in one call | 0–2 (median 2) | 0–3 (median **1**) |

(Numbers are the auditable re-run persisted to `runs.jsonl` — three rows per mode, `"batching"` field set.)

**What this does and does NOT show (read before citing these numbers):**

- **Directional signal — precision, within noise:** full batching had the lowest false-positive median (1 vs 2) with no
  recall cost, but the FP ranges overlap heavily (batched 0–3, split 2–3, current 0–4) — 12 loci / 9 clean at N=3 is
  squarely inside this harness's known noise floor (see the variance section above). Read it as "batching does not hurt
  and may modestly help precision," **not** as a measured precision win. Replication softened an earlier single, un-persisted
  run that looked cleaner — the exact pattern the North Star exists to catch.
- **It measures batching *intensity* (compose-all vs compose-none), NOT a specific correlated pair.** The `batched`
  mode forces every fired persona into one call; it is not evidence about pairing two particular lenses.
- **Single model.** This is glm-5-turbo only. A prompt/harness change can help one model and hurt another, so this
  is not a general result — multi-model runs are required before any batching default changes.
- **The corpus cannot exercise the Docker+CI pairing at all:** it has separate Docker and CI cases but **no case that
  co-touches both**, so stevedore+marshal never co-fire on any of the 18 cases. A separate hand-built joint-defect
  probe (a Docker stage rename + a stale CI `--target` reference, needing both files to catch) scored **paired 3/3 vs
  unpaired 3/3** — i.e. pairing gave **no** advantage, because every persona already receives the *full multi-file
  diff* (`src/pi/worker.ts` `renderAnalysisPrompt` appends all files). The `when` globs pick *which* lenses fire, never
  *what* they see — so no lens is ever "blind" to another's files.

**Decision (#39):** ship the `pass` grouping primitive (a backward-compatible generalization of `solo`, opt-in via
`.squarewright.yml`) and the `--batching` eval knob, but **do NOT enable any default pairing** — the specific pairing
is not corpus-validated, precision is not the current bottleneck (recall is: still low, ~0–2/12), and precision/recall are
coupled (tuning one moves the other — that balancing act *is* calibration, and must be done across models, not by
optimizing one number on one model). The primitive is ready; a default pairing has not earned its place yet.

## Model rank + reasoning + self-consistency + structurer (2026-07-09)

A full sweep on the golden corpus (personas, `thinking off` unless noted, free z.ai structurer), scored by the
**defect-match judge** (`scripts/judge.ts`, zai:glm-5.2) — more trustworthy than file-level (which inflates ~1.5–4×), but
see the caveats below: this is a **single judged repeat per config on 12 loci**, and the judge is **same-family as the
top-ranked models**. Treat the rank as **directional, not settled** — the ordering was consistent across the session's
runs, but a 6-vs-5-vs-4 spread at N=1 is within this harness's known variance (recall swings 1→3 on *identical* reruns —
see the variance section above). **Do not switch the shipped default on this alone** — confirm first (below).

### The headline: our default model looks like a poor choice — but the exact numbers do NOT reproduce

Reasoning-off, defect-level recall / 12, **from a single judged report per model** (the numbers below are ONE draw each):

| model | defect recall (1 draw) | re-judge range (other saved runs) |
|---|---|---|
| glm-5.2 | 6 | **2–7** (median ~4) — does not reproduce 6 |
| glm-4.5 | 6 | (not re-audited) |
| deepseek/deepseek-v3.2 | 6 | (not re-audited) |
| glm-5 | 5 | **2–3** — never reached 5 |
| glm-4.7 | 5 | file-level 6–9 across runs; N=1 sampling baseline judged **3** (self-inconsistent — see sampling note) |
| glm-4.6 | 5 | **2–3** — never reached 5 |
| glm-5.1 | 4 | (not re-audited) |
| glm-4.5-air | 3 | (not re-audited) |
| **glm-5-turbo** (the *current* default) | **1** | consistently low (0–1) across runs |

**Honest read (corrected after an accuracy audit re-ran the judge on the saved reports):** the fine ordering (6 vs 5 vs 4)
is **noise** — re-judging other saved runs gives glm-5.2 = 2–7, glm-5 = 2–3, glm-4.6 = 2–3. What *is* directionally robust:
**glm-5-turbo reasoning-off sits consistently at the bottom (0–1/12)** and several capable models score higher on average —
but with large run-to-run variance, so the "6/12" magnitude and the exact rank are **NOT established.** There is no
directly-comparable defect-judged baseline to compare against (the old "~3/12" was a *file-level*, since-debunked figure).
**This needs ≥3 judged repeats per model + a different-family judge before it can drive a default change.** File-level
scoring still misled (glm-5-turbo looks "clean" but is near-blind); the judge is a better metric, just not at N=1.

### Reasoning helps weak models, hurts capable ones

| model | reasoning-off | reasoning-on | reasoning-max |
|---|---|---|---|
| glm-5-turbo (weak) | 1 | **3** (high) | — |
| glm-5.2 (capable) | 6 | 6 (high) | 5 (xhigh) |
| deepseek-v3.2 (capable) | 6 | **3** (high) | — |

Reasoning **rescues a weak model** (turbo 1→3) but **does nothing or actively hurts capable ones** (glm-5.2 flat/down,
deepseek **halved** 6→3). The file-level metric lied here — glm-5.2@max looked like 10/12 (best!) but judged to 5/12
(*below* its reasoning-off 6): max reasoning made it *prolific*, not *correct*. So **reasoning-off on a capable model is
the operating point**; "max reasoning" is not a quality mode. Reasoning-on also costs 5×+ latency (200s+/case on z.ai).

### Self-consistency sampling — a real recall lever (with a precision cost)

`--samples N` runs each pass N times and unions the findings (`--consensus K` keeps only findings recurring in ≥K
samples). On glm-5-turbo, N=5 union lifted **defect recall 0 → 2**, and on glm-4.7 a separate run went **3 → 8** (its N=1
here judged 3 — different draw than the rank table's 5, which is exactly the variance problem above). An informal read of
which cases flipped between N=1 and N=5 suggested most misses are "reachable but rare" (union recovers them) rather than
routing/prompt gaps — but this "miss-class" read was never persisted as a checkable artifact (issue #45's AC1). Cost:
false positives rise with the model's base noise, and `consensus≥2` at N=5 over-prunes (real catches are as rare as noise
at that N). A genuine recall knob for the precision↔recall curve, but small-N; validate per-model before enabling.

### Structurer default → free z.ai (cost footgun fixed)

Pass-2 structuring ran on a **paid** OpenRouter default (`qwen3-coder-30b`) — it fires on every pass of every review, so
it quietly dominated cost (a full-corpus sweep spent ~$3 on structuring alone; the eval's own runs racked up thousands of
calls). Changed `DEFAULT_STRUCTURER` to free **zai/glm-5-turbo**. The change is justified on **cost** (free vs paid, and
it runs every pass) — *not* on quality: the earlier "glm-5-turbo structurer = ~1 noise vs qwen's ~24–34" reading is
**confounded** with analysis-model choice (no same-analysis structurer-only comparison exists), so we do not claim it's a
better structurer, only a free one that worked reliably all session. A z.ai config now forces no OpenRouter at all. Follow-up ideas: default the structurer to the
cheapest configured lane's provider (coherent with any setup), and save the pass-1 analysis text so structurer models can
be compared **offline** without re-running analysis.

### Honest caveats (read before acting on any number here)
- **The numbers do not reproduce, at TWO levels.** (a) Analysis variance: different saved runs of the same config judge differently (glm-5.2 across audits spanned **2–8**, not the "2–7" one audit reported). (b) **The judge itself is stochastic** — re-judging the *identical* report gave 8 then 7. So the "median ~4 / range 2–7" figures are themselves unstable; treat them as "wide and unsettled," not a closed interval.
- **What actually survives repeated re-judging:** glm-5-turbo reasoning-off scored **0/12 three times** (worst, robust); its reasoning-high scored **3/12** (reasoning rescues the weak model). The rest is within measurement noise.
- **The judge (glm-5.2) is same-family as the top-ranked models** (5 of 8 candidates are GLM) — self-preference risk, not cross-validated by a different-family judge.
- **`ci-moby-52727` is a structurally unsolvable locus** — it scored `defect=0/1` in *every* judged report (real bug is in an external workflow, not the diff; the local `id-token` line is commented-out). It's now **relabeled `clean` in the manifest**, so the effective ceiling is **11 has-issue loci, not 12** — read the "/12" figures above as "/11 achievable" (they overstate headroom-to-perfect, though not relative rank, since it was a constant miss for all).
- deepseek numbers are one paid model on OpenRouter (its reasoning-on run was *not* truncated by the 32k cap — max ~15k tokens/case). GLM numbers are z.ai free-tier. "capable vs weak" is a coarse axis (the reasoning-hurts-capable half rests mainly on deepseek's 6→3; glm-5.2 was flat at high, only max dropped).

**Before switching the shipped default model** (`src/init/default-config.ts`), you need a genuinely reproducible setup — **≥3 analysis repeats × multiple judge re-scores per report, a pinned/low-temperature or different-family judge, and ci-moby fixed** — not just "≥3 repeats." As it stands this is a *lead*, not a result.

## Provisional default switch: review lanes → z.ai glm-5.2 reasoning-off (2026-07-09)

Maintainer-directed. The dogfood/scaffold **review** lanes (`strong`, `cheap` in `src/init/default-config.ts`, mirrored to `.squarewright.yml`) moved from `glm-5-turbo` to free z.ai **`glm-5.2` reasoning-off**. The **structurer** stays free `glm-5-turbo` (mechanical pass-2).

This is deliberately a **weak, provisional claim, not the settled rank**: it only spends the *robust* half of the measurement — glm-5-turbo reasoning-off is the reproducibly-**worst** reviewer (0/12 ×3) — so moving *off* it is safe. It is **NOT** a claim that glm-5.2 beats the other capable models (glm-4.5 / deepseek-v3.2 tied it at one draw; glm-5.2 itself re-judged **2–8**). It's acceptable now only because this is **pre-v0.1 test config with no external users** (few have a z.ai subscription) — the default is a dev/dogfood artifact, not a product commitment.

The **real product-release default** remains a separate future decision: product-safe, cheap end-to-end if OpenRouter, and gated on the reproducible re-measure above (issue #49, AC4). The M7 gate still governs *that* choice; this change does not close it.

## Cross-family (non-GLM) judge — cross-check (2026-07-09, #49 AC2)

The defect judge defaults to z.ai `glm-5.2`, which is the **same family** as most ranked candidates → self-preference risk. To cross-check, `scripts/judge.ts --model <provider:model>` can point the judge at any Pi model. Findings, judging the same saved glm-5.2 report (thinking:xhigh):

| judge | family | defect-recall | cost/run | notes |
|---|---|---|---|---|
| `zai/glm-5.2` | GLM | 6/11 | free | the default (same-family) |
| **`openrouter/deepseek/deepseek-v3.2`** | DeepSeek | **6/11** | **~$0.01** | cross-family — **agrees** with glm-5.2 |
| `openrouter/qwen/qwen3-coder:free` | Qwen | 0/11 ⚠️ | free | **broken** — never called `submit_grades` |
| `openrouter/meta-llama/llama-3.3-70b-instruct:free` | Llama | 0/11 ⚠️ | free | **broken** — same tool-call failure |

**Reads:**
- **A cross-family judge (deepseek-v3.2) agrees with glm-5.2 (6/11 = 6/11)** on this report — the glm-5.2 judge is *not* obviously self-preferential. This is N=1 (one report, one pass each); #49d runs it across the rank via `--reports`/`--judge-repeats`.
- **Free OpenRouter models fail as judges** — both qwen3-coder:free and llama-3.3-70b:free returned 0-across-the-board because they never called the `submit_grades` tool (thinking-off), which the judge scores as all-miss. A `0` from a judge that didn't tool-call is not a measurement.
- **New guard:** the judge now reports a `graded` flag per call, and `scripts/judge.ts` prints a warning when any call failed to tool-call (`⚠️ judge did not call submit_grades on N/M calls`), so a broken-judge `0` can never be silently read as real recall.
- **The cross-family cross-check must use a *cheap paid* non-GLM (deepseek-v3.2, ~$0.01/run capped by `--max-spend`)**, not a free model.

## Reproducible interval on the robust-worst model (2026-07-09, #49 AC4, bounded)

First use of the hardened toolkit (`--reports` matrix × `--judge-repeats`) to report a config's recall as an **interval on real data** — 4 full-corpus same-config `glm-5-turbo` reports (analysis) × 2 glm-5.2 judge passes each, free z.ai:

```
overall (analysis × judge): 0–2 (median 0.5) / 11
analysis variance (per-report medians): 0–1.5 (median 0.5)   ← worker run-to-run spread
judge variance (within-report range):   0–1 (median 0)        ← judge stochasticity at this floor
```
Per-report: `[1,1] [0,0] [0,0] [1,2]` / 11.

**Reads:**
- **This confirms the one *robust* rank fact as a proper interval:** glm-5-turbo defect-recall is **0–2/11 (median 0.5)** — reproducibly the worst, now with variance decomposed rather than a single lucky/unlucky point. The bulk of the spread is *analysis* (worker) variance; the judge is stable at this low level.
- **Methodology validated on real data** — the matrix mode, the spread math, and the honesty guards all work end-to-end. Notably the `--reports` "different loci totals" guard *fired correctly* on a first attempt where two reports shared a `.config` but covered different case subsets → **`.config` does not record the case set; a matrix needs same-*corpus* reports (here, 18-result full-corpus runs), not just same-config.**
- **This is NOT the full rank re-measure (#49 AC4).** It's one model (the robust-worst). A complete rank needs **≥3 fresh `eval --repeat` analysis runs per candidate model** (a multi-hour z.ai job, quota-sensitive) fed through this same matrix + a deepseek cross-family cross-check. The tooling is ready; the run is the remaining work. Until then, the shipped default (glm-5.2) stays a **provisional** pick, not a measured rank winner.

## Calibration-prompt audit — measured, NOT shipped (2026-07-09, #47)

AC1 audited `CLEAN_TAIL` (appended to every persona prompt): it already carried **empty-findings-is-valid** + **grounded**, but lacked **defer-to-CI** and **truncation-safe** — the two anchors cc-dcp's scout bundled. We added them and measured before/after per AC2/AC3 — clean-case false positives (file-level) + **defect-recall (judged, `--judge-repeats 2`)**, 2 models × `--repeat 3`, free z.ai.

| model | prompt | defect-recall /11 (judged) | clean-FP (file-level) |
|---|---|---|---|
| glm-5.2 (default) | before | 4–6 (median **5**) | 8–16 (median **11**) |
| glm-5.2 (default) | **after** | 4–5 (median **4**) | 8–19 (median **15**) |
| glm-5-turbo (weak) | before | 0–2 (median **1.5**) | 0–2 (median 1) |
| glm-5-turbo (weak) | **after** | 0–1 (median **1**) | 0–1 (median 0) |

**Decision: NOT shipped — the current prompt is kept.** AC3's bar is "ship only if precision improves without a recall regression outside noise." The added anchors met neither:
- On **glm-5.2 (the default)**, precision got *worse* (clean-FP median 11→15) *and* defect-recall dropped (5→4) — both axes worse.
- On **glm-5-turbo (weak)**, false positives fell (1→0) but defect-recall regressed with them (1.5→1) — the recall-suppression risk the reviewer flagged, a bad trade on a model already at the floor.

Ranges overlap heavily (much is run-to-run noise), but **nothing pointed to a benefit** and the default model regressed on both axes — so cc-dcp's bundled result (+14.7pp precision / −5.2pp recall) does **not** transfer to our corpus/models; here we'd take the recall cost without the precision gain. A negative result is a result: this is exactly why review-quality changes gate on measurement, not faith. (A *different* calibration formulation — e.g. paired with think-first, or narrower anchors — is untested and would be a fresh experiment, not this one.)

## Tier-A `.review-rules` actually change a review — repeatable fixture (2026-07-09)

The first honest before/after of the shipped rule-loading feature (ADR-0005 §1). The 18-case golden corpus
**cannot** measure this — those external repos have no `.review-rules/`, and `scripts/eval.ts` drives the Worker
directly, never the `runReview` rule-injection path. So `scripts/measure-rules.ts` + `eval/rules-fixture/` drive
the **real product path** (`cli.ts review` → `runReview` → `fsRepoReader`) over a **made-up** rule (`Date.now()`
→ a fictional `clock.ts`, fake repo `acme/widget`) the model cannot know from training. Both detectors are the
deterministic `detectRuleFinding` (unit-tested) over two committed targets, so the reviewer run is the only
variable and **the whole table reproduces from one command:** `RUNS=5 bun run scripts/measure-rules.ts`.
glm-5.2, 5 runs/arm.

| detector | rule ON | rule OFF | what it measures |
|---|---|---|---|
| **rule-specific** (cites `clock.ts`/`replay` — `target.json`) | **5/5** | **0/5** | did the rule make the reviewer invoke the *documented convention*? |
| inclusive (any `Date.now` flag — `target-inclusive.json`) | 5/5 | **1/5** | did the violation get flagged *at all*? |

- **The rule works, cleanly:** the reviewer invokes the project-specific convention **5/5 with the rule, 0/5
  without** — impossible to mention `clock.ts`/`replay` without the injected rule, so OFF=0/5 is the honest floor.
- **The baseline is NOT zero on the inclusive measure:** the model flags `Date.now()` on its own (1/5 this run,
  2/5 an earlier run — generic testability concern), so a naive "flagged?" metric overstates the rule's effect.
  An earlier hand-rolled **3/0** single sample was over-optimistic — exactly the single-flattering-number trap
  Hard Rule #5 warns against; ≥3 runs + the split detector corrected it.
- **Run-to-run variance is real:** a prior 5-run pass gave rule-specific **4/5** (vs 5/5 here) and inclusive-OFF
  **2/5** (vs 1/5); the *direction* is stable (rule-specific ON ≫ OFF ≈ 0), the exact counts are not — report the
  range, never a single count.
- **Caveats:** one fixture, one model, N=5 — a *directional* result, not a precision/recall number. A **golden-PR
  variant** (a real corpus defect + a rule targeting it) is the next measurement — more realistic, at the cost of
  possible training-leak on real conventions. Extending this fixture with drift-trigger cases is the base for
  rule-drift (ADR-0005 §2).

## Golden-PR rules probe — baseline × Tier-A × Tier-B × A+B on a REAL defect (2026-07-10)

Does a rule help catch a **real, documented** defect (not just a made-up one)? Case **`ts-vite-21019`** (a
`copyDir` → `fs.cpSync` refactor vite reverted: omits `dereference: true` so symlinks stop being followed, + a
Windows non-ASCII `fs.cpSync` bug). The real diff → an artifact (`scripts/diff-to-artifact.ts`), reviewed through
the product path in four arms — **same convention content, different delivery** — via `eval/golden-rule-probe/run-arms.sh`.
glm-5.2, 3 runs/arm; graded by one consistent Claude subagent judge (defect-match: independently names the
concrete symlink/dereference or Windows regression, NOT merely "violates the rule").

| arm | delivery | caught the real defect |
|---|---|---|
| Baseline | nothing | **1/3** |
| Tier-A | convention as `.review-rules` **precedence rule** | **3/3** |
| Tier-B | same convention as a **background doc** (`contextDocs`) | **3/3** |
| A+B | both | **2/3** |

- **Rules help on a REAL defect, not just synthetic ones:** unaided, glm-5.2 catches this `fs.cpSync` symlink
  regression only **1/3**; with the rule OR the doc it's **3/3**. Combined with the synthetic made-up rule
  (prior section, **0/5 → 5/5**), the honest story is: **rules meaningfully lift recall — decisively for
  conventions the model can't infer, and materially even for a real defect it only *sometimes* catches unaided.**
- **⚠️ This corrects a confounded earlier run.** A first pass used the PR title *"Use fs.cpSync instead of custom
  copyDir"* — which **names both functions**, a strong hint. Under that leading title the baseline scored **3/3**
  and the probe wrongly read as a "ceiling effect (rules add nothing on real defects)." Re-run with a **neutral**
  title (*"Simplify recursive file copying…"*) the baseline dropped to **1/3** and the rules' lift appeared. The
  PR title is a real signal the reviewer uses — a lesson for corpus design, and a reminder to distrust a single
  arrangement. (sqw-reviewer on PR #69 caught the title confound.)
- **Over-loading (A+B) is no better, maybe slightly worse:** A+B **2/3** vs A or B alone **3/3** — one run
  (`ab_3`) stayed generic ("defaults have shifted across Node versions") without asserting the concrete regression.
  Small, within N=3 noise, but consistent with "don't stack context reflexively" — supports Tier-B off-by-default.
- **Caveats:** one case, one model, **N=3/arm** (a 1/3 baseline could be 0–2/3 with more runs — direction is the
  signal, not the exact count); grading is by subagent judge (documented protocol), not a committed deterministic
  script; judge stochasticity is real (an earlier per-arm-judge pass read A+B as 1/3, a consistent judge 2/3).
  The 12 graded outputs are committed under `eval/golden-rule-probe/runs/` for audit; reviews reproduce via
  `RUNS=3 bash eval/golden-rule-probe/run-arms.sh` + `scripts/diff-to-artifact.ts`.

## Honest interval on the SHIPPED default glm-5.2 (2026-07-10, #49 AC4 first step)

Before treating any v0.1 dogfood finding as representative, an honest committed number for the current default
(council 2026-07-10). Protocol: **3 fresh `eval --repeat` analysis reports** (free z.ai glm-5.2, reasoning-off,
grounding off) **× 2 judge passes** with a **cross-family** judge (deepseek-v3.2, avoids GLM self-preference,
#49 AC2). Report×judge matrix via `scripts/judge.ts --reports … --judge-repeats 2`.

| metric | glm-5.2 (shipped default) |
|---|---|
| **defect-match recall (judged, cross-family)** | **1–4 / 11 · median 3** |
| file-level locus recall (inflated ~2×) | 6–7 / 11 · median 6 |
| clean-case false positives (file-level, raw) | 13–25 · median 14 |
| judge spend | ~$0.02 (deepseek, capped) |

Per-report judged pairs: [1,3] · [3,3] · [4,1]. Analysis variance (per-report medians) 2.5–3; judge variance
within a report 0–3 (report 3 swung 4→1 — the judge is itself stochastic, HR#5). 

- **This is the recall bottleneck, measured on the shipped default:** the reviewer catches a **median ~3 of 11
  real defects (~27%)**. The file metric (6–7) overstates it ~2×, exactly as AGENTS.md warns — do NOT quote the
  file number as recall.
- **Implication (council):** recall — not the feedback loop (M6 §2–4) — is the v0.1 blocker. The next lever is
  self-consistency sampling (`--samples`/`--consensus`) promoted to the review path with a precision guard, or a
  model re-rank (the full #49 AC4). A dogfood reviewer at ~3/11 recall will *look* quiet/clean, which reads as
  "well-calibrated" unless you already know to distrust the silence.
- **Caveats:** N=3 reports, one model; the interval is wide (1–4) and both analysis + judge contribute variance.
  This is a first honest AC4 step, not the full multi-model rank. Reports are gitignored; re-run:
  `ZAI_API_KEY=… bun run scripts/eval.ts --provider zai --model glm-5.2 --repeat 3 --concurrency 5` then
  `bun run scripts/judge.ts --reports "<3 paths>" --judge-repeats 2 --model openrouter:deepseek/deepseek-v3.2`.

## Self-consistency (`--samples 3`) does NOT fix glm-5.2 recall (2026-07-10, loop, #45)

Council's cheapest recall lever, tested. glm-5.2 `--samples 3` (union of 3 sampled analysis passes), same
cross-family deepseek judge:

| | defect recall (judged) | file recall |
|---|---|---|
| baseline (`--samples 1`, 3 reports) | 1–4/11 · median **3** | 6–7 |
| `--samples 3` (2 reports, per-pass [3,2] · [1,1]) | 1–3/11 · median **~2** | 5–6 |

- **No lift — arguably slightly worse.** Across 2 reports samples=3 recall (1–3, median ~2) undershoots the
  baseline (1–4, median 3). Union-of-samples recovers *reachable-but-rare* misses; that it didn't help — and
  perhaps hurt (extra sampled candidates the structurer consolidates imperfectly) — means glm-5.2's misses are
  largely **model-ceiling** (fundamental reasoning gaps), not sampling-recoverable. **The bottleneck is the
  model.**
- **Implication:** the recall fix is a **better analysis model** (the full #49 AC4 rank sweep — needs paid OR
  spend + go-ahead), not a free sampling knob. Self-consistency stays a possible small precision/recall knob but
  is **not** the recall answer for this model.
- **Confirmed (2 reports).** Both samples=3 reports undershoot the baseline; the direction is stable even with
  judge variance. This closes the free-lever question — recall needs a model change, which is a maintainer
  go/no-go on the paid sweep.

## Model re-rank for recall — RETRACTED as a rank; N=1-noise-dominated (2026-07-10, #49 AC4 / #45)

> **⚠️ CORRECTION (2026-07-10, adversarial re-review — the section below overstated its conclusion; read this
> first).** An adversarial critic + follow-up confound tests showed the "no premium model beats free glm-5.2"
> headline is **not supported at the resolution claimed** — it was a single noisy draw per model inside a band the
> data itself can't separate. What actually holds:
> - **N=1 variance is enormous and dominates everything.** Judging *the same model* (sonnet-5) across three
>   configs gave **5 → 3 → 2 /11** (reasoning-off+deepseek-struct → reasoning-off+self-struct →
>   reasoning-low+deepseek-struct). glm-5.2's own honest interval is 1–4/11. The reported 5-vs-4 "win" is **inside
>   the noise** — a coin-flip, not a rank.
> - **The file metric is ANTI-correlated with judged recall at the top.** Those same sonnet configs scored
>   **7 → 8 → 9 /11 file-level** while judging **5 → 3 → 2** — i.e. the config that found the *most* file-matching
>   findings caught the *fewest* real defects (the extra findings were hedged/wrong-root-cause noise that hit the
>   right file). **Never rank on file recall; it can invert the true order.**
> - **Un-handicapping premium did NOT rescue it.** Reasoning-on and a matched self-structurer *raised file recall
>   but lowered judged recall* — so the confounds are real (they change the numbers) yet don't produce a premium
>   win; they add noise.
> - **Structurer mismatch + unauditability (fixed):** glm-5.2 ran with its shipped `glm-5-turbo` structurer, the
>   premium models with `deepseek-v3.2` — not apples-to-apples, and `eval.ts` never even recorded the structurer
>   in the report (now fixed — the report `config` persists `structurer`).
> - **Contamination unaddressed:** the corpus is *famous, publicly-reverted* PRs (tokio/vite/rails…) — maximally
>   likely in pretraining. A "shared ~3/11 ceiling" could be memorization saturation, not corpus difficulty. The
>   "ceiling = corpus difficulty" sub-claim is **unsupported**.
> - **Judge = same family as 2/7 candidates** (Claude judging sonnet-5/opus-4.8), never cross-checked for that pair.
>
> **The ONLY defensible takeaway:** glm-5.2 (free) is **competitive in this ~2–5/11 band — not shown to be beaten**
> by any paid model tested. So there's **no evidence a switch is justified** (keep free glm-5.2 by default) — but
> that is "no paid model has been *shown* better," NOT "no model *can* beat it." A real rank is **unrun**: it needs
> ≥3 fresh reports/model, a **matched** structurer, a **cross-family non-Claude** judge, reasoning tested per
> model, and a contamination-safe (post-cutoff/synthetic) locus set. Until then this is a **lead, not a result**.
> The table below is kept as the record of what led here.
>
> **UPDATE (2026-07-10):** that prescription (matched structurer, 3 reports/model, cross-family judge, judge noise
> averaged) was then **executed for the two models that matter** — see *"Matched-structurer, cross-family, N=3
> re-test"* at the end of this file. Result: sonnet-5 keeps a **~0.5–1 locus median edge inside overlapping
> ranges** — a lead within noise, not a separation, for $10/M vs free. The "no switch justified" call is now
> **measured** for the live decision, not asserted. The full-field rank and contamination fix remain unrun.

Full re-rank prompted by glm-5.2's honest ~3/11 recall. Ran candidate analysis models over the full golden
corpus (real PRs), reasoning off, **deepseek-v3.2 structurer** (see the structurer note below), then judged.
**The judge choice dominated the result** — the paid deepseek judge is noisy/harsh (same model swings 1↔4);
the reliable read is a **Claude subagent judge** (free, cross-family, reads the diffs), 1 strong report/model,
one identical strict defect-match rubric:

| model | subagent-judged | deepseek-judged (noisy) | file-level (≥2 runs) | cost/M (in–out) |
|---|---|---|---|---|
| **claude-sonnet-5** | **5/11** | 1–4 | 7 (stable) | $2 / $10 |
| **glm-5.2** (current default) | **4/11** | 1–4 (med 3) | 6–7 | **free (z.ai)** |
| **claude-opus-4.8** | **4/11** | 3–4 | 6–7 | $5 / $25 |
| deepseek-v3.2 | (mid) | 1–3 | 3–6 (med 6) | $0.21 / $0.32 |
| gpt-5.6-luna | (mid) | 1–3 | 3–5 (med 4) | $1 / $6 |
| llama-4-maverick | ~1 (file was noise) | ~1 | 5–8 (med 6) | $0.30 / $1.2 |
| gemini-3.5-flash | **blocked** — mandatory reasoning (guard refused) | — | — | $1.5 / $9 |

- **No premium model decisively wins.** sonnet-5 (5) leads by **one locus** (N=1 report — not significant), and
  the **free glm-5.2 (4) ties opus-4.8 (4)** which costs $25/M out. The money buys marginal-at-best recall.
- **The recall ceiling is ~4–5/11** even for top models (opus 4, sonnet 5) — it's **corpus difficulty** (subtle,
  cross-domain, real reverted defects), not model choice. This redirects #45 away from "pick a better model."
- **The judge matters more than the model here.** The deepseek judge under-credited everything ~2× (glm 1–4 vs
  subagent 4); reported ranges are dominated by judge stochasticity. A reliable judge (subagent, or the golden
  diffs read directly) is the honest tool. glm-5.2's true recall is **~4/11, not 3** — the earlier deepseek
  number was low.
- **Caveats:** N=1 report/model on the subagent judge (a strong sample, not an interval); file-level overcounts
  ~2× (llama's 6 file → ~1 judged); the deepseek-structurer pairing is fixed across candidates (a stronger
  structurer might lift some — see the nosub note).
- **Guards verified end-to-end:** reasoning-trap preflight (analysis + structurer, #79) auto-refused v4-flash,
  kimi, grok, glm-on-OR, fable, gemini; credit breaker + `--max-spend` held; total session OR spend ~$3.6.

### The structurer was silently capping recall (nosub, #78)
The free `glm-5-turbo` structurer produces **empty reviews (`nosub`) for capable analysis models** (deepseek,
Luna) — it can't extract findings from their output format → 0 recall, a measurement artifact, not the model.
Swapping to a **deepseek structurer** fixed it (deepseek 0→submits). Implication: the two-pass structurer is a
recall lever in its own right — a weak structurer drops findings from a strong analysis model. Worth measuring a
stronger default structurer across models (the pairing matrix at N=1 was inconclusive — needs a real sweep).

**#78 close-out (2026-07-10, decided — keep the default).** A 3-structurer probe on deepseek-v3.2 *analysis*
(glm-5-turbo vs glm-5.2 vs deepseek-v3.2 structurer, 2 has-issue cases) was **too confounded to rank cleanly**:
the eval re-runs the analysis pass per arm, so it never feeds the *same* analysis text to each structurer, and
deepseek analysis is itself noisy/nosub-prone (even the paid deepseek structurer got 0/4 that run; glm-5.2
structurer recovered one case at raw 7). Takeaway: part of "nosub" is **analysis variance**, not purely the
structurer, and **no cheap structurer reliably fixes capable-model nosub**. Decision: **keep the free
`glm-5-turbo` structurer default** — the shipped default (glm-5.2 analysis) is unaffected; nosub only bites
*capable/paid* analysis models, which aren't the default. A clean structurer rank would need a **fixed-analysis
eval mode** (run analysis once → feed N structurers) — deferred, not worth it while capable models aren't the
default. **Operational note:** to run a capable model (e.g. **Sakana Fugu**) usefully, pair it with
`--structurer openrouter:deepseek/deepseek-v3.2` — that pairing produced Fugu's 8/11 file / 5–6 judged; the
default glm-5-turbo structurer would nosub it.

### Matched-structurer, cross-family, N=3 re-test — the retraction's prescription, executed (2026-07-10)
The retraction above said a real comparison needs: **matched structurer**, **≥3 fresh reports/model**, a
**cross-family non-Claude judge**, judge stochasticity averaged. Ran exactly that for the **two models that
matter** (the shipped default vs the strongest contender), both with the **same `deepseek-v3.2` structurer**,
3 reports each, each report judged twice (`--judge-repeats 2`) by **two independent cross-family judges**:

| model (matched deepseek struct) | deepseek judge (6 passes) | glm-5.2 judge (6 passes) | file-level (3 runs) | cost/M out |
|---|---|---|---|---|
| **claude-sonnet-5** | 2–4, **med 2** | 2–4, **med 3.5** | 7,7,7 (stable) | $10 |
| **glm-5.2** (current default) | 1–3, **med 1.5** | 1–4, **med 3** | 4–7 (med 6) | **free** |

- **Both cross-family judges agree on the shape:** sonnet-5 carries a **~0.5–1 locus median edge**, and the
  ranges **overlap heavily** (sonnet low = 2 sits inside glm's 1–3 / 1–4). A lead within the noise band, **not a
  separation** — the exact pattern the retraction predicted, now measured properly instead of at N=1.
- **The money buys ~half a locus of median recall, maybe.** sonnet-5 is $10/M out; glm-5.2 is free (z.ai). On a
  ~11-locus corpus that edge is not worth a paid dependency + rate-limit exposure. **No switch justified — and now
  it's *shown*, not asserted.** Keep free glm-5.2 as the default.
- **Judge choice shifts the absolute numbers, not the ranking.** The deepseek judge scores ~1 locus lower across
  the board than the glm judge (harsher/noisier, consistent with earlier notes), but both put sonnet ≈ glm within
  overlap. The ranking is judge-robust even though the point values aren't.
- **This does NOT reproduce the earlier "sonnet 5 vs glm 4" subagent gap** — that was N=1. At N=3×2×2-judges the
  gap shrinks to ~0.5–1 median inside the overlap. Higher N ate the apparent gap, as expected.
- **The deepseek structurer buys recall *and* clean-case noise together — a real precision cost.** The matched
  glm-5.2+deepseek-struct runs threw **6 / 10 / 17 false-positive findings across 10 clean cases** (~0.6–1.7
  FP/clean), vs the shipped glm-5-turbo structurer path's **~0–0.4 FP/clean**. `cleanFP` counts *findings* on
  clean cases (all false positives), and it can exceed `cleanCases` — 17/10 is 17 FP-findings, not "all cases
  flagged." So the structurer swap that fixes nosub (#78) and lifts *file* recall is **~3–4× noisier on clean
  cases** while judged recall barely moves. This is the precision half of the retraction's "more findings = more
  noise" — chasing recall via a stronger structurer degrades precision for ~0 judged-recall gain. Reinforces
  keeping the shipped free `glm-5-turbo` structurer as default; feeds #73 (precision cost) and #78.
- **Still open (unchanged):** contamination (famous reverted PRs) is unaddressed, so the shared ~2–4/11 band may
  still be memorization-saturation not corpus difficulty; and this covers 2 models, not the whole field. But for
  the one decision that was live — *switch off free glm-5.2 to a paid model for recall?* — the answer is now a
  measured **no**. Judging spend for this section ~$0.3 (deepseek passes; glm judge free).

### Sakana Fugu — the first model that clearly beats free glm-5.2 on judged recall (2026-07-10)
Tested Sakana AI's **Fugu** + **Fugu Ultra** (new reasoning models; `https://api.sakana.ai/v1`, OpenAI-compatible,
added to Pi via a `models.json` custom provider — Pi ships no first-party Sakana). Full golden corpus (Fugu) /
8 has-issue cases (Ultra), matched **deepseek-v3.2 structurer**, both cross-family judges, `--judge-repeats 2`:

| model (reasoning) | deepseek judge | glm-5.2 judge | file | latency/case |
|---|---|---|---|---|
| **fugu** (high) | **[5,5] med 5** | **[6,6] med 6** | 8/11 | 40–263s |
| **fugu-ultra** (high, +concise-note) | [4,6] med 5 | [6,6] med 6 | 8/11 | 116–847s |
| glm-5.2 (free) | 1–3 med 1.5 | 1–4 med 3 | 6 | ~10–60s |
| sonnet-5 | 2–4 med 2 | 2–4 med 3.5 | 7 | ~10–60s |

- **Fugu roughly DOUBLES judged recall over free glm-5.2** (~5–6 vs ~1.5–3), and it's the most judge-robust
  result of the session: BOTH cross-family judges agree, and within-report variance is ~0 ([5,5], [6,6], [6,6])
  — the findings are unambiguous enough that judges don't waver. This is the **first real evidence that recall is
  model-liftable, not a pure corpus-difficulty ceiling** — it partially walks back the "ceiling ≈ corpus
  difficulty" reading above. Still **N=1 analysis report/model** (run-to-run analysis variance untested — the
  session's standing caveat; needs ≥3 reports to be a settled rank), but it clears the bar the retracted N=1
  claim failed: two-judge agreement + zero within-report wobble + a *large* gap (5–6 vs 1.5–3, not 5-vs-4).
- **Fugu Ultra ≈ Fugu at the same effort.** Both ~5 (deepseek) / 6 (glm). The pricier tier ($5/$30 per M vs
  Fugu's unpublished/subscription price) buys **nothing** here — **effort level, not model tier, is the lever**.
- **Reasoning is MANDATORY — a trap by our rule.** No "off" mode; only `high`/`xhigh` accepted (others rejected);
  Pi's "off" degrades to the server default (high/ultra→xhigh), still billing reasoning. Our OpenRouter
  reasoning-trap preflight can't see it (Sakana ≠ OpenRouter) → **no automatic guard**. Fugu Ultra is $30/M out on
  pay-as-you-go; both are free but quota-heavy on a Sakana subscription (one full-corpus + partial Ultra run ate
  ~62% of a 5h quota window).
- **A "be concise, don't overthink, limit multi-agent exploration" system-prompt note did NOT reduce the burn.**
  ts-vite: with-note **225s** vs without **226s** — identical. `reasoning_effort:high` owns the reasoning budget
  server-side; you can't prompt Fugu out of it (rust-tokio still took **847s** with the note). It nudged quality
  slightly (ts-vite 0/2→1/2). Recorded as a deliberately-biased exploratory run (`--note`, only on this Ultra run).
- **Verdict for THIS project (free-glm-on-a-personal-sub):** Fugu is **not a default switch** — mandatory
  reasoning, 40–847s/case, and a paid/quota dependency are the opposite of the free-glm thesis. But it's a solid
  **"premium recall option when recall matters more than cost/latency,"** and the strongest single argument that a
  better *reasoning* model — not a better *structurer* or *sampling* — is what moves the recall needle (#45).

### #73 — precision cost of loading rules + rule-drift: none detectable above the noise (2026-07-10)
Council-directed (all three lenses put this next; the skeptic made it a blocker on §3/§4). Measured clean-case
false positives on the 10 clean golden cases, 3 arms × 3 runs, free glm-5.2 (z.ai), via new `scripts/eval.ts`
flags `--rules <file>` (injects a `.review-rules` preamble faithfully, like `runReview`) and `--rule-drift`.
Generic cross-language rules fixture (`eval/rules-precision-fixture.md`) — NOT the repo's own `architecture.md`,
which targets `src/**` and wouldn't apply to the external corpus PRs.

| arm | clean-FP (raw findings on 10 clean cases) | median |
|---|---|---|
| A — baseline (no rules, no drift) | 6–20 | 11 |
| B — rules ON | 9–17 | 12 |
| C — rules + rule-drift ON | 9–15 | 9 |

- **No measurable precision cost.** Rules-ON (med 12) ≈ baseline (med 11), and rules+drift (med 9) is if anything
  lower — all three intervals overlap almost entirely. Loading a plausible rules file, and enabling the §2
  rule-drift shipped this session, did **not** detectably increase clean-case false positives.
- **Run-to-run variance SWAMPS any effect.** Baseline alone swung **6 → 20** on identical config. The noise floor
  is far larger than any arm-to-arm gap, so a *small* precision cost can't be ruled out without many more runs —
  but nothing at the scale that would matter is visible. (Same N-dominated-by-variance lesson as the whole
  session; do not over-claim "rules are free," only "no cost detectable at this N.")
- **Rule-drift's anti-noise gating holds empirically.** Its marginal clean-FP is ~0 — proposals are gated on
  rules + capped ≤1/pass + "only when a pattern clearly qualifies," so on clean external PRs they rarely fire.
- **What "clean-FP" is / isn't:** raw findings on real merged PRs with no *known* defect — many are legit nits,
  not false alarms; this is a relative ON-vs-OFF precision signal, not an absolute error rate. The real takeaway
  for precision is the **large raw-nit floor (6–20) of glm-5.2**, which a verifier/nit-suppression pass would move
  far more than anything rules-related.
- **Consequence:** the skeptic's blocker is cleared — §2 rule-drift doesn't measurably add noise, so building
  §3/§4 on top isn't compounding an unmeasured problem. Recall side of rules (do they get *flagged*) is the
  separate `scripts/measure-rules.ts` probe (already shows rules lift recall). #73 precision half: **answered.**

### Contamination-safe corpus — first build + first signal (2026-07-11)
Council thrust: the golden corpus is **famous** reverted PRs (tokio/vite/rails), near-certainly in every model's
pretraining, so a "catch" there might be recall-of-training-data, not review skill — which makes golden a poor
instrument for ranking models (esp. frontier ones that may memorize harder). Built a second corpus
(`eval/contam-safe/`, run via the new `scripts/eval.ts --manifest <path>` flag) of the **same kind** of case — a
real bug-introducing PR, evidence-backed by a later revert or a regression-fix PR that names it — but from
**obscure/medium repos** (124–2337★): `Khan/genqlient` (ws deadlock), `tafia/calamine` (whitespace eaten),
`Riey/kime` (Hangul layout regression), `jelmer/dulwich` (>8KB loose-object parse regression), `inokawa/editate`
(collapsed-cursor format no-op), `wakujs/waku` (middleware-order static-file hijack; 6363★ — flagged, higher
contamination risk). 6 has-issue (7 loci) + 3 clean. All curated via GitHub PR archaeology (subagents), each
introducing-PR verified to exist, be <60K after the diff slice, and touch its locus (dropped `hauler#515`: 176K
diff, locus beyond the slice).

**The instrument works:** free glm-5.2 (thinking off) shows real **spread** — file recall **2/4** (6-case subset)
and **1/7** (full 9-case) across two runs, catching calamine + dulwich, missing the deadlock / ordering / cursor
bugs. Not all-caught (would mean too-easy/memorized), not all-missed (too-hard). Gradeable.

**First memorization-vs-difficulty signal (a LEAD, not a result):** glm-5.2's file recall here (~15–30%, 1–2/7)
is **proportionally LOWER than on golden** (~55%, median 6/11 — **file-level; golden's *judged* recall is only
~27%, 1–4/11 (see "Honest interval" above) — do not read ~55% as real recall**; the comparison holds because both
sides are file-level here). That gap is *consistent with* golden recall being
partly familiarity-inflated — a model does worse on defects it can't have memorized. BUT it is **not proof**: the
contam-safe bugs may simply be harder (subtle concurrency/encoding/ordering defects), N is 1 run × file-level ×
7 loci (variance is enormous — the same corpus swung 2/4→1/7), and clean-FP was inflated by one 85K truncated
clean diff (`waku-1493`, 11 of 17 FPs). The **real** memorization test is the *model-ranking gap*: run ≥3 judged
reports of glm-5.2 AND a frontier model on BOTH corpora — if the frontier model's advantage over glm SHRINKS on
contam-safe, golden's frontier ranking was memorization. That comparison is the next step; this build makes it
runnable. Reproduce: `bun run scripts/eval.ts --manifest eval/contam-safe/manifest.yaml --provider zai --model glm-5.2 --thinking off`.

### Memorization verdict — golden is a valid instrument; Fugu's edge is real (2026-07-11)
The contamination question, answered. Ran glm-5.2 (free) and Sakana Fugu on BOTH corpora + deepseek-v4-pro
(opencode Go) on contam-safe, has-issue only, **matched structurer** (free zai:glm-5.2), N=2 reports, judged by
glm-5.2 (free), 2 passes each. (Also fixed a real bug: `scripts/judge.ts` hardcoded the golden manifest for the
case→loci map, so judging ANY other corpus silently scored /0 — now a `--manifest` flag, matching `eval.ts`.)

| model | golden judged (mean /11) | contam-safe judged (mean /7) |
|---|---|---|
| glm-5.2 (free) | 3.25 (~30%) — passes 2,2,4,5 | 2.25 (~32%) — passes 2,2,2,3 |
| **Sakana Fugu** | **5.5 (~50%)** — 4,6,6,6 | **4.0 (~57%)** — 3,4,4,5 |
| deepseek-v4-pro (opencode Go) | — | 1.25 (~18%) — 0,1,2,2 |

- **Fugu ÷ glm gap: 1.7× on golden, 1.8× on contam-safe — it HOLDS.** If golden's ranking were memorization,
  Fugu's advantage would COLLAPSE on obscure/unmemorizable repos; instead it's near-identical. So **the golden
  corpus is NOT significantly contamination-inflated — it's a valid instrument for ranking models.** The skeptic's
  central worry is answered with evidence, not assertion. glm-5.2's own recall is also the same on both (~30% vs
  ~32%) — no memorization boost for it either.
- **Fugu's advantage is real reviewing skill (~1.7–1.8× over free glm-5.2)**, reproduced on code it can't have
  memorized — a contamination-safe confirmation of the earlier Fugu result. The earlier "~2×" was partly a
  STRUCTURER confound (Fugu had used a deepseek structurer, glm the free glm-5-turbo); with a matched structurer
  the honest edge is ~1.7–1.8×. Fugu stays a **premium, opt-in, expiring (2026-07-29), reasoning-trap** option —
  NOT the free default. glm-5.2 remains the default.
- **deepseek-v4-pro via opencode Go is NOT a recall upgrade** (~18% judged, below free glm's ~32%; its file-level
  3/7 was noise). opencode key tested + works (Go tier `/zen/go/v1`; the PAYG frontier models are unreachable —
  $0 balance), but its open models don't beat free glm on recall.
- **Caveats:** N=2 reports × 7-loci (contam) / 11-loci (golden), single (free glm-5.2) judge — same-family to the
  glm BASELINE, which would if anything INFLATE glm and make the Fugu gap CONSERVATIVE. The robustness signal is
  the **cross-corpus consistency** (1.7 vs 1.8), stronger than any single N. A paid cross-family judge + N≥3 would
  tighten it, but the direction is clear. Reproduce: the two runs are logged in `eval/runs.jsonl`.
