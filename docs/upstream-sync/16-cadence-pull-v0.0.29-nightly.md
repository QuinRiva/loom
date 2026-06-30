# 16 — Cadence pull: v0.0.28 → v0.0.29-nightly.20260630.695

First steady-state pull after the Phase 1–2 migration. Australian English.

## Headline

- **Window:** `2448212367` (v0.0.28, the Phase-2 merge-base) → `upstream/main`
  `9d66b104f` (v0.0.29-nightly.20260630.695). **Only 3 upstream commits, 6 files.**
- **Zero conflicts.** `git merge upstream/main` produced a clean recursive merge;
  the two files our fork also touched auto-merged on disjoint lines.
- All gates green; live boot smoke test against a DB copy passed. Merge commit
  `01521c01d`.

## The 3 upstream commits

| Commit      | Change                                                     | Overlap with fork?                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0615fd7df` | Add middle-click close for right panel tabs (#3161)        | `RightPanelTabs.tsx` — our fork added Tasks/Workstream tabs + props at the top of the file; upstream added `onMouseDown`/`onAuxClick` handlers in the function body. Disjoint regions, auto-merged.                                                                                                                                                             |
| `51ea084c8` | Warm WSL before preflight in WSL-only backend mode (#3588) | None. `DesktopBackendConfiguration.ts` (+1 line). WSL-only; inert on Linux.                                                                                                                                                                                                                                                                                     |
| `9d66b104f` | Add Claude Sonnet 5 as default Claude model (#3620)        | `contracts/src/model.ts` — upstream flipped `CLAUDE_DRIVER_KIND` default `claude-sonnet-4-6 → claude-sonnet-5` and added sonnet-5 aliases; our fork's `PI_DRIVER_KIND`/`PI_DEFAULT_MODEL` additions are on separate lines. Both present in the merged result. Also touches `ClaudeProvider.ts`, `ProviderModelsSection.tsx`, `model.test.ts` (no fork overlap). |

## What I re-applied / verified

Nothing to re-home — no fork capability was displaced. Verified the two
auto-merges semantically: the merged `model.ts` keeps upstream's new
`claude-sonnet-5` Claude default **and** our `[PI_DRIVER_KIND]: PI_DEFAULT_MODEL`
entries; `RightPanelTabs.tsx` keeps upstream's middle-click handlers **and** our
Tasks/Workstream tab surface.

## Gates

- `vp run typecheck`: pass (0/15; two non-blocking `suggestion` advisories in
  upstream's own `apps/desktop` code, pre-existing).
- `pnpm build`: exit 0 (all 5 build targets).
- `vp check`: 0 errors, 15 warnings (pre-existing `react/no-unstable-nested-components`
  in `apps/mobile`, unrelated to this pull).
- **Live smoke test:** built `apps/server/dist/bin.mjs` launched on a spare port
  (13955) against a _copy_ of `~/.t3/cockpit/userdata/state.sqlite`. Booted clean,
  `migrations: []` (no new migrations — consistent with zero DB/schema files in the
  window), `GET /` → HTTP 200, workstream-liveness + session-reaper started. The
  live cockpit on the default port was never touched.

## Why this pull was cheap (cadence confirmation)

This validates the Phase-2 enabling fact in practice: `merge-base` is the real
upstream commit `2448212367`, so `git merge upstream/main` Just Works with a
normal three-way merge — no grafts, no replace-refs. Conflict cost scaled with
_overlap_ (2 fork-touched files of 6), not commit count, exactly as doc 05 §4
predicts. Frequent small pulls keep this trivial.
