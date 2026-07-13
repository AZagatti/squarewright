# Divergence-bug corpus seed (2026-07-13)

Real-world, live-verified cases where a change introduced a **security or correctness defect by diverging from a
pattern the same codebase already established** (a sibling does the safe thing; the changed/new code doesn't).
Gathered to (a) answer the falsifiability question for the consistency/divergence lens — *is this a real defect
class maintainers want fixed?* (**yes**, all 9 have merged fixes, several CVE/segfault/ICE/deadlock-backed) — and
(b) seed a labeled eval corpus so the lens can be **measured** rather than shipped on taste. See the
`## Consistency/divergence lens` entry in `RESULTS.md` for the experiment + prior-art synthesis.

**Key design signal:** `diff-only` = the sibling is visible in the PR's own diff; `same-file` = sibling is in a
changed file but in a hunk the PR didn't touch (needs the full file); `cross-file` = sibling lives in a file the
PR never touched (needs repo retrieval). Tally: ~4 diff-only, ~2 same-file, ~3 cross-file → a **file-aware** check
(read the full changed files) reaches ~6/9; diff-only only ~4/9.

| # | Repo | Defect | Evidence | Sibling scope |
|---|---|---|---|---|
| 1 | golang/go | `copy()` missing `append()`'s nil-check ordering → compiler ICE | issue #79687; fix `b32177443d` ("Same fix as CL 718860, but for copy builtin") | cross-file |
| 2 | pulumi/pulumi | `Close()` idempotent early-return skips `Unlock()` → deadlock | PR #21112 (bug) / #21117 (fix: "we forgot to unlock") | diff-only |
| 3 | vercel/turborepo | `import_attributes: true` added to one SWC config, not the sibling in another crate → parse failure | issue #10961; fix PR #11053 ("didn't apply the same fix to the boundaries module") | cross-file |
| 4 | zsh-users/zsh | `scangroup()` missing `getgroup()`'s `PM_UNSET` guard → segfault | fix `6dfaf678ad` ("fix in 52783 was incomplete… getgroup has the same check") | same-file (~30 lines) |
| 5 | go-gitea/gitea | 3 API routes missing `reqRepoReader(unit.TypeCode)` that `/languages`,`/licenses` have | CVE-2026-27783; fix PR #37769 | diff-only (same file) |
| 6 | go-gitea/gitea | API `CreateFork` missing `CanCreateOrgRepo` that `CreateOrgRepo` has → secret exfil | CVE-2026-22555; fix PR #36950 | cross-file |
| 7 | goshs-labs/goshs | CSRF guard added to POST `upload()`, not sibling PUT `put()` right above | CVE-2026-42091 / GHSA-rhf7-wvw3-vjvm; fix `0e715b94e1` | diff-only (same file) |
| 8 | dani-garcia/vaultwarden | `get_org_collections_details` given weaker check than sibling `get_org_collections` **in the same commit** | CVE-2026-33420 / GHSA-jjxg-p3v6-52ww; commit `c555f7d198` | diff-only (same commit) |
| 9 | immich-app/immich | API-key `update()` missing `create()`'s `isGranted` permission guard → privilege escalation | CVE-2026-23896 / GHSA-237r-x578-h5mv; fix `b123beae38` | same-file (~15 lines) |

Case 8 (Vaultwarden) is the strongest single datapoint: the maintainer's *own* commit added the safe check to one
function and not its sibling 24 lines below, in the same diff — a human reviewing both side-by-side still let it
through, which is the argument for a mechanical sibling-consistency check.

**Excluded / didn't fully verify (do not use without re-check):** Mastodon rate-limit, FileBrowser login
rate-limit, Kestra & NocoBase SQLi (these were the *same* bad pattern repeated, not a divergence from a safe
sibling — a different class), Zulip bot-role CVE, NodeBB #14405 `getRaw` (an auth case, kept for a future security
set). To turn this into a runnable corpus: freeze the introducing diff per case (`eval/divergence/diffs/<id>.diff`)
+ a manifest with `expect_loci` = the diverging line, mirroring `eval/golden/`. Also minable at scale from
**ManySStuBs4J** (filter to fixes whose repo had a sibling pattern at fix time).
