# 17 — Cadence pull: v0.0.29-nightly.20260630.695 → v0.0.29-nightly.20260705.729

Second steady-state pull. Mobile-dominated window. Australian English.

## Headline

- **Window:** `9d66b104f` (v0.0.29-nightly.20260630.695, the previous merge-base)
  → `upstream/main` `600972084` (v0.0.29-nightly.20260705.729). **9 upstream
  commits, mostly mobile + a Vite Plus toolchain upgrade.**
- **One textual conflict:** `pnpm-lock.yaml` (from the Vite Plus upgrade, #3679),
  resolved by regenerating the lockfile rather than hand-editing.
- **One _semantic_ merge conflict** git could not flag: upstream's new mobile
  thread-shell construction sites did not satisfy loom's extended
  `OrchestrationThreadShell` contract. Fixed in two files (see below).
- All gates green after the fix; live boot smoke test against a DB copy passed.
  Merge commit `4c7877268`, with `upstream/main` correctly preserved as the
  second parent (`HEAD^2 == 600972084`).

## The 9 upstream commits

| Commit      | Change                                                          | Overlap with fork?                                                                                                              |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `600972084` | Add repo-root favicon.svg so t3 code shows its own icon (#3683) | None.                                                                                                                           |
| `e26e55f38` | Combined mobile test branch — scroll, back-swipe, lists (#3687) | Large mobile restructure; removed many `apps/mobile/src/app/**` route files. Triggered the semantic shell-shape conflict below. |
| `4ac094fef` | Surface pending tasks in mobile home and draft flow (#3670)     | Mobile-only.                                                                                                                    |
| `a7e43b228` | Upgrade Vite Plus and enable bundled dev opt-in (#3679)         | **The lockfile conflict.** Bumped `vite-plus` (now 0.2.2) + related devDeps; regenerated `pnpm-lock.yaml`.                      |
| `cabc93bad` | Make the thread composer read as elevated liquid glass (#3668)  | None (web CSS/component, disjoint from fork).                                                                                   |
| `5cda81562` | Compile patched native pods from source on EAS (#3667)          | iOS/EAS build config; inert on Linux.                                                                                           |
| `32d17d3db` | Adaptive split-view layout for iPad/mobile workspace (#3514)    | Mobile-only; part of the shell-shape surface.                                                                                   |
| `6d35a87c5` | Fix electron dev launch and add test (#3662)                    | Desktop dev; inert here.                                                                                                        |
| `7b9eef7ac` | Restore the ultrathink frame border effect (#3625)              | `apps/web/src/index.css` — both sides touched. Auto-merged on disjoint regions; verified (below).                               |

## The lockfile conflict (Vite Plus upgrade)

`pnpm-lock.yaml` was the only textual conflict. Resolved the correct way — not
by hand-merging the YAML: took upstream's lockfile as the base
(`git checkout --theirs pnpm-lock.yaml`), then `pnpm install` (Node 24.18)
reconciled it against the merged `package.json` set. A second `pnpm install` was
a no-op (`git diff --exit-code pnpm-lock.yaml` clean), confirming idempotence.

**Vite Plus toolchain sanity:** after install, `vp` resolves to `v0.2.2` from the
upgraded devDep and all gates run under it — nothing about the new toolchain
looked off.

## Two auto-merged Pi files — verified semantically

- **`apps/web/src/index.css`** — loom's ultrathink-frame border customisation
  (the `::before` mask-composite border trick around line 812) **and** upstream's
  appended MDX-plan GFM prose block (line 891+) both survived, in disjoint
  regions. Coherent.
- **`packages/client-runtime/src/state/threads.ts`** — loom's extraction of the
  thread-state types into `threadState.ts` (import + re-export) **and** upstream's
  new ephemeral reasoning-delta handling (the `reasoningFinalized` set,
  `applyReasoningStreamItem`, `DateTime`/`MessageId` imports) both survived.
  Coherent.

## The semantic merge conflict (no textual marker)

Upstream `e26e55f38`/`32d17d3db` added mobile code that builds
`EnvironmentThreadShell` literals — a brand-new `homeListItems.test.ts` and a
rewritten `use-thread-selection.ts`. Those literals carry **upstream's** field
set, but loom's `OrchestrationThreadShell` contract (from the workstream/goals
feature) requires ~20 extra fields (`goalId`, `parentThreadId`, `role`,
`purpose`, `brief`, `planLane`, `attention`, `blockedBy`, `routes`, `isolation`,
`fanInState`, `lastActivityPreview`, …). Git auto-merged the text cleanly, so
only `vp run typecheck` surfaced it (two `TS2740` errors).

Fixed to satisfy loom's contract, mirroring loom's own sibling factory
(`homeThreadList.test.ts`):

- `apps/mobile/src/features/home/homeListItems.test.ts` — added the missing
  workstream fields to the test `makeThread` factory with loom's canonical
  defaults (nulls / `"planned"` / `"shared"` / `"none"` / empty arrays).
- `apps/mobile/src/state/use-thread-selection.ts` — the `threadDetailToShell`
  projection now copies the workstream fields from the full `OrchestrationThread`
  (which carries them all), except the shell-only `lastActivityPreview`, defaulted
  to `null`.

This is a merge-completion fix, not a feature change — no coexistence shim, no
contract drift.

## Gates

- `vp run typecheck`: **0 errors** (after the shell-shape fix). Non-blocking
  `suggestion` advisories remain in `apps/desktop` and `apps/server`
  (`WorkstreamFanInReactor`) — pre-existing, unrelated.
- `pnpm build`: exit 0 (all 5 targets).
- `vp check`: **0 errors**, 25 warnings. The warnings are upstream's own dead
  imports left by its heavy mobile refactor (e.g. `cn`, `fileBreadcrumbs` in
  `ThreadFilesRouteScreen.tsx`) plus a pre-existing loom test warning — all
  non-blocking, none in fork-critical code.
- **Live smoke test:** built `apps/server/dist/bin.mjs` launched on spare port
  13955 against a _copy_ of `~/.t3/cockpit/userdata/state.sqlite`. Booted clean,
  "Migrations ran successfully" (existing migrations through
  `47_ProjectionThreadWorktreeIsolation`; none new — consistent with zero
  DB/schema files in the window), `GET /` → HTTP 200, workstream-liveness +
  session-reaper started, no crash. The live cockpit on the default port was
  never touched.

## Merge topology

`git merge --no-edit upstream/main` produced a normal two-parent merge commit —
no rebase, no squash, no flatten. `HEAD^1 == a2e796503` (loom `origin/main`),
`HEAD^2 == 600972084` (upstream). Once this branch merges into `loom/main`, the
merge-base advances to `600972084`, keeping the next pull cheap.
