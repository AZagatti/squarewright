# Setup-development results

> **⚠️ Correction (2026-07-06, later): the numbers below were measured on a BROKEN harness and an inflating
> metric — treat them as superseded.** A four-angle investigation found: (1) a **silent tool-drop bug** — the
> worker returned empty findings (scored as "clean") when the model reasoned but never called the tool, worse
> at higher reasoning effort; (2) **file-level scoring over-credits** — a finding on the right *file* counted as
> a hit even if it described a different bug. Both are now fixed: the worker is **two-pass** (reason → structure)
> so it can't silently drop, and a **defect-match judge** (`scripts/judge.ts`) scores real root-cause matches.
> On the same personas-off run, the judge corrected **file-recall 5/12 → defect-recall 3/12** (~25%, in line
> with trimwire's ~27% reality). Also: Pi's reported cost badly undercounts reasoning tokens — real spend is now
> read from OpenRouter's credits balance. Re-runs on the fixed harness are the real numbers; the table below is
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
  without a bigger model: the **structurer's selectivity** dominated noise (glm-5-turbo structurer ~1 vs
  qwen3-coder ~24–34), independent of the analysis model.
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
**defect-match judge** (`scripts/judge.ts`, zai:glm-5.2) — the only trustworthy metric (file-level inflates ~1.5–4×).
Single judged repeat per config; treat magnitudes as ±1–2 on 12 loci, but the ordering is robust and repeated.

### The headline: our default model was the single worst choice

Reasoning-off, **defect-level recall / 12** (all free z.ai except deepseek):

| model | defect recall | note |
|---|---|---|
| **glm-5.2** | **6** | top tier |
| **glm-4.5** | **6** | top tier — a cheap/fast "4x" model, surprisingly strong at review |
| **deepseek/deepseek-v3.2** | **6** | paid, but ~$0.05/run with the free structurer |
| glm-5 | 5 | |
| glm-4.7 | 5 | |
| glm-4.6 | 5 | |
| glm-5.1 | 4 | |
| glm-4.5-air | 3 | |
| **glm-5-turbo** (the prior default) | **1** | dead last |

**Switching the default from glm-5-turbo → glm-5.2 / glm-4.5 takes real recall 1 → 6 (6×), for free.** This is the
biggest quality lever found, and it's just model selection. It also **doubles the project's prior best-ever** (~3/12).
File-level scoring had hidden this — glm-5-turbo looks "clean" (few findings) but is nearly blind; the judge exposes it.

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
samples). On glm-5-turbo, N=5 union lifted **defect recall 0 → 2** and on glm-4.7 **3 → 8** — the miss-class map showed
most misses are "reachable but rare," and union recovers them. Cost: false positives rise with the model's base noise
(clean on glm-5-turbo, a firehose on noisier models), and `consensus≥2` at N=5 over-prunes (real catches are as rare as
noise at that N). It's a genuine recall knob for the precision↔recall curve; validate per-model before enabling.

### Structurer default → free z.ai (cost footgun fixed)

Pass-2 structuring ran on a **paid** OpenRouter default (`qwen3-coder-30b`) — it fires on every pass of every review, so
it quietly dominated cost (a full-corpus sweep spent ~$3 on structuring alone; the eval's own runs racked up thousands of
calls). Changed `DEFAULT_STRUCTURER` to free **zai/glm-5-turbo**, which our own data shows is also a *better* structurer
(~1 noise vs qwen's ~24–34). A z.ai config now forces no OpenRouter at all. Follow-up ideas: default the structurer to the
cheapest configured lane's provider (coherent with any setup), and save the pass-1 analysis text so structurer models can
be compared **offline** without re-running analysis.

### Honest caveats
- Single judged repeat per config, 12 loci — directional; the ordering repeated across the session's runs, magnitudes may shift ±1–2.
- deepseek numbers are one paid model on OpenRouter; the GLM numbers are z.ai free-tier.
- The reasoning conclusion is defect-judged and consistent across GLM + deepseek, but "capable vs weak" is a coarse axis.
