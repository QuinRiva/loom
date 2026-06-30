---
manager_sessions:
  - id: a7efb56b-5ec9-4d03-a478-3fc857fc0887
    role: analysis
    authored_at: 2026-06-30T04:03:21.923Z
---

# Upstream sync — history & baseline analysis

_Phase 1 / Task A. Analysis only; no source changed._

## Headline

- **Baseline upstream commit: `477795697d8546a8db4903bd878a5ad3196423b9`**
  - Date: **2026-06-14 16:47:56 -0700** (`refactor: resolve host process state through Effect (#2959)`, by Julius Marminge)
  - **Confidence: very high** (see evidence below).
- **Recommendation: establish a synthetic merge-base with `git replace --graft`**, splicing our fork root `6c82133` onto baseline `477795697`. This is reversible, costs nothing, and immediately yields a correct 3-way merge picture. Promote it to a permanent rewrite with `git filter-repo` only if/when we want the grafted history to be the real shipped history.
- **The "1772 files changed" figure is an artefact, not the work.** The real conflict surface is **106 files** — the files both the fork and upstream touched since the baseline. 319 files were changed by the fork, 1535 by upstream; only their 106-file intersection can actually conflict.

## 1. No shared ancestry — confirmed

```
git merge-base HEAD upstream/main      → (empty)
git merge-base origin/main upstream/main → (empty)
fork root  : 6c82133  "checkpoint: pi-only fork foundation (Phase 0-3)"  2026-06-16 09:15 +1000
upstream root: 3579005  (different root entirely)
upstream/main HEAD: 2448212  "chore(release): prepare v0.0.28"  2026-06-29
```

The two graphs share no commit. The fork was **not** created with `git clone`/`git fork`; it was bootstrapped as a **content copy of a t3code working tree** committed afresh as a brand-new root commit (`6c82133`, dated 2026-06-16). The fork's own history (~40 commits) then grew from that root. This is why git cannot compute a merge-base and why a naïve `git diff HEAD upstream/main` reports a nonsense 1772-file delta — with no common ancestor, git contrasts two whole trees that are independently ~2 weeks of drift apart.

## 2. Which upstream snapshot the fork was copied from

Method: for every upstream commit in the 2026-06-12…06-17 window, count files differing from the fork root tree (`git diff --name-only 6c82133 <commit>`), then confirm the winner blob-by-blob.

| upstream commit | date | files differing from fork root |
|---|---|---|
| **`477795697`** | **2026-06-14 16:47 -0700** | **50** |
| `de8bdc10` | 2026-06-15 14:17 | 111 |
| `c2d44a31` / `9d5e632d` / `71ea5fa1` | 2026-06-15 | 122 |
| `d0a7d18c` | 2026-06-16 00:10 | 124 |
| … | … | ≥132 |

`477795697` is a sharp local minimum. Commits **after** it (closer to the fork's 06-15 23:15 UTC checkpoint date) score *worse*, exactly as expected if the fork was cut at `477795697` and upstream then diverged on top of it.

Blob-level confirmation against `477795697`:

- **5205 of 5240 fork-root files are byte-identical** (same blob SHA) to the baseline tree.
- The entire 35-file fork-side delta is precisely the Phase 0-3 pi work plus a small vendored-repo trim — nothing incidental:
  - **Fork-only files (9):** `apps/server/src/goal/GoalPackage.ts`, `apps/server/src/persistence/{Layers,Services}/ProjectionGoals.ts`, `…/Migrations/033_ProjectionGoals.ts`, `apps/server/src/provider/Drivers/PiDriver.ts`, `…/provider/Layers/Pi/{Cli,RpcProcess}.ts`, `goals/pi-frontend/goal.md`, `progress.md`.
  - **Modified (26):** orchestration (`decider`, `projector`, `Schemas`, `ProjectionPipeline`, …), contracts (`orchestration`, `model`, `providerRuntime`, `settings`, `baseSchemas`), `builtInDrivers`, `serverRuntimeStartup`, web (`ChatView`, `CommandPalette`, `store`, `modelSelection`), `client-runtime/addProject`, `shared/model`.
  - **Files upstream had that the fork dropped (15):** vendored `.repos/alchemy-effect/scripts/release/*` and `.repos/effect-smol/scratchpad/*` material.

This is a clean fork-foundation fingerprint. Confidence is very high that `477795697` is the exact snapshot copied.

## 3. Establishing a merge substrate — options

`477795697` **is already an ancestor of `upstream/main`** (`git merge-base --is-ancestor` → yes), and there are **289 upstream commits** from baseline to nightly `2448212` (matches the expected "~289"). So baseline → both tips is well-defined the moment we give git an edge from our root to it.

### (a) Synthetic merge-base via `git replace --graft` (→ optional `git filter-repo`) — **recommended**

```sh
git replace --graft 6c82133 477795697   # fork root now "descends from" baseline
git merge-base HEAD upstream/main        # → 477795697   ✓
```

Verified live in this worktree: after the graft, `merge-base HEAD upstream/main` resolves to `477795697`; removing the replace ref (`git replace -d 6c82133`) restores the no-ancestor state. A real 3-way `git merge upstream/main` will then base off `477795697` and only present genuine divergence.

- **Feasibility:** proven here, takes seconds.
- **Risk:** very low. `git replace` is a local overlay ref (`refs/replace/*`); it changes no commit, is trivially reversible, and need not be pushed. `git filter-repo --replace-refs` later bakes the graft into real history if a permanent clean lineage is wanted (that step *does* rewrite SHAs and needs a force-push + coordination across the ~10 shared worktrees).
- **Preserves our work fully:** all fork commits stay; we only add a parent edge.
- **Caveat:** a plain two-tree `git diff HEAD upstream/main` still prints 1772 files — that command ignores the merge-base by design. Use 3-way merge, or `git diff 477795697...upstream/main` / `git diff 477795697 HEAD`, to see real attribution.

### (b) Re-baseline: replay fork features as patches onto current upstream

Check out `upstream/main`, then reconstruct the 35-file pi delta on top (cherry-pick fork commits — needs `--onto` with the same graft anyway — or apply the feature diff as fresh commits).

- **Feasibility:** moderate. The pi surface is small and well-isolated (9 new files + 26 edits), so a hand-applied re-baseline is tractable.
- **Risk:** medium. Loses the fork's own commit history/attribution unless carefully replayed; the 26 modified files must be re-applied against 289-commits-newer upstream versions (this is the same per-file work as option (a)'s merge, just without git's 3-way assistance).
- **Best as the _output_ of (a), not a substitute:** do the grafted 3-way merge to discover the true conflicts, then optionally land the result as a clean re-baselined branch.

### (c) Hybrid — recommended end-to-end path

1. `git replace --graft 6c82133 477795697` (analysis substrate; reversible).
2. Drive Phase-1 conflict mapping and the Phase-2 merge off the real merge-base — the 106-file overlap is the only zone needing human/AI judgement; the other ~1429 upstream-only files fast-forward and the 213 fork-only-touched files carry through untouched.
3. Decide at ship time whether to keep the grafted merge history or `filter-repo` it into a permanent linear re-baseline.

## Conflict surface (the number that matters)

Computed against baseline `477795697`:

| set | files |
|---|---|
| Changed by fork (`477795697..HEAD`) | 319 |
| Changed by upstream (`477795697..upstream/main`) | 1535 |
| **Changed by BOTH (true conflict candidates)** | **106** |

The 106 overlap files (full list captured during analysis) are concentrated in: `apps/server` text-generation + provider adapters + orchestration, `apps/web` chat/sidebar/store, `packages/contracts` (`orchestration.ts`, `settings.ts`, `rpc.ts`, `server.ts`), `client-runtime` ws transport/protocol, and lockfiles/`package.json`. These — plus the pi-only files — are the scope for Task D's per-zone resolution.

## Reproduce

```sh
B=477795697d8546a8db4903bd878a5ad3196423b9
git diff --name-status 6c82133 $B            # 35-file fork fingerprint (15A/9D/26M from upstream's POV)
git merge-base --is-ancestor $B upstream/main && echo baseline-is-ancestor
git rev-list --count $B..upstream/main       # 289
git replace --graft 6c82133 $B && git merge-base HEAD upstream/main   # → 477795697
git replace -d 6c82133                        # undo
comm -12 <(git diff --name-only $B HEAD|sort) <(git diff --name-only $B upstream/main|sort) | wc -l  # 106
```
