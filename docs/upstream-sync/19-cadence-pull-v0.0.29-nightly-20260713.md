# 19 — Cadence pull: v0.0.29-nightly.20260709.769 → v0.0.29-nightly.20260712.791

Fourth steady-state pull, and the cheapest since #16. The window is dominated by
a single large-but-isolated feature — upstream's #3579 Android mobile support —
which touches only `apps/mobile/**` code loom does not diverge on. Australian
English.

## Headline

- **Window:** `f61fa9499` (v0.0.29-nightly.20260709.769, the previous
  merge-base) → `upstream/main` `c1ec1915f` (v0.0.29-nightly.20260712.791).
  **3 upstream commits, 168 files, ~17.4k insertions** — but ~99% of that is one
  self-contained Android feature under `apps/mobile/`.
- **1 conflicted file:** `pnpm-lock.yaml` (Android deps). No source conflicts.
- **1 semantic (marker-less) merge issue**, git could not flag — an upstream
  Android composer file built without loom's `thread` inline-token variant;
  surfaced by `tsgo` and fixed by mirroring loom's canonical iOS handling.
- **No migrations** in the window.
- All three gates green (typecheck 0 errors, build exit 0, `vp check` 0 errors).
  Live boot smoke test on a DB copy passed. Merge commit `db162b44a`,
  `HEAD^2 == c1ec1915f`, both parents intact.

## The 3 upstream commits

| Commit      | Change                                                  | Overlap with fork?                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ef943a26a` | Fix truncated chat error alert layout (#3899)           | `apps/web/src/components/chat/ThreadErrorBanner.tsx` (+9/−9). Loom does not diverge on this file; auto-merged clean.                                                                                                                             |
| `619b0ece9` | Marketing: platform-appropriate commit shortcut (#3644) | `apps/marketing/src/pages/index.astro` (+3/−1). No loom overlap; auto-merged.                                                                                                                                                                    |
| `c1ec1915f` | Add Android mobile support (#3579) — the bulk           | Entirely `apps/mobile/**` (native Android modules, ghostty-vt vendor, plugins, screens) plus `app.json` and `pnpm-lock.yaml`. Loom's divergence is server/web/contracts, not mobile — near-zero overlap. One semantic token-variant gap (below). |

## The 1 semantic (marker-less) merge issue

Git auto-merged the text cleanly; only `tsgo` surfaced it.

1. **`apps/mobile/src/native/T3ComposerEditor.native.tsx`** — upstream's new
   Android/shared composer variant maps `collectComposerInlineTokens(...)` to
   display labels but handled only the `skill` / `mention` / file cases,
   calling `basename(token.value)` on the fallback. Loom's inline-token union
   carries a **`thread`** variant (`{ type: "thread"; id; label; … }`, no
   `value` field) for its thread-mention capability, so `token.value` does not
   exist on that arm → `TS2339`. Fixed by mirroring loom's canonical handling
   already present in the sibling **`T3ComposerEditor.ios.tsx`**: added the
   `token.type === "thread" ? token.label : basename(token.value)` branch.
   This preserves loom's thread-mention rendering on Android exactly as on iOS.

## Lockfile + install

`pnpm-lock.yaml`: took upstream's (`git checkout --theirs`), then installed
under pnpm **11.10.0** (corepack honoured the root `packageManager`). Same flow
as #18:

- Ran with `CI=true` (pnpm 11 aborts a modules purge without a TTY).
- The first install needed `--no-frozen-lockfile` once (a `patchedDependencies`
  config-vs-lockfile mismatch); the subsequent frozen install is a no-op.
  Idempotence confirmed: a following `--frozen-lockfile` install passes and
  leaves `pnpm-lock.yaml` unchanged.

No ad-hoc `allowBuilds` flags needed; the Effect LSP `prepare` patch ran clean.

## Gates

- **`vp run typecheck`**: **0 errors** across all 15 projects. Only pre-existing
  `suggestion` advisories remain (`WorkstreamFanInReactor`, a couple of
  test-file / `apps/desktop` effect-idiom hints, `client-runtime`
  discovery.ts) — non-blocking.
- **`pnpm build`**: exit 0, all 5 targets.
- **`vp check`**: **0 errors**, 15 warnings — all pre-existing
  (`react/no-unstable-nested-components` in `apps/web` chat markdown/UI,
  `no-unsafe-optional-chaining` in `decider.reviewGate.test.ts`), none in the
  resolution surface.

## Live smoke test

Built `apps/server/dist/bin.mjs` launched on spare port **13961** against a
_copy_ of `~/.t3/cockpit/userdata/state.sqlite` (`T3CODE_HOME` sandboxed to a
temp dir; the live cockpit on the default port was never touched). Booted clean,
**"Migrations ran successfully"** with **`migrations: []`** (no new migrations in
the window — consistent with zero migration files in the delta). `GET /` →
**200**; workstream-liveness, session-reaper, exhaustion-resume, and the
subscription-usage poller all started; no crash. Process killed, DB copy removed.

## Merge topology

`git merge --no-edit upstream/main` produced a normal two-parent merge commit;
the lockfile resolution + semantic fix were folded into it via `--amend` (both
parents preserved). No rebase, no squash, no flatten. `HEAD^1 == eee3f009e`
(loom `origin/main`), `HEAD^2 == c1ec1915f` (upstream). Merge commit
`db162b44a`. Once this merges into `loom/main` the merge-base advances to
`c1ec1915f`, keeping the next pull cheap. This sync note is a separate docs
commit on top so it can cite the final merge hash.

## Intentional prior drops — NOT "fixed" here

DiffPanel working-tree diff (`/api/vcs/diff`), `pinnedCollapsedThread`, Pi-only
driver registry, deferred read-only Goals/tasks UI. Left untouched.
