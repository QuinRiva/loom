# 12 — Phase 2.6: Tail fixes + verification

Closes out the catalogued small fixes after the re-home phases (2.2–2.5b) and
records the final verification state of the merged worktree. All work committed
locally; the graft is left intact (no `git filter-repo`, no push).

Pre-tail HEAD: `824a656cc` (end of 2.5b). Pre-merge fork SHA for recovery:
`6150362cf`.

## Task outcomes

### M1 — terminal worktree-local `.bin` PATH re-home ✅

The fork prepended the terminal's own worktree `node_modules/.bin` to `PATH` so an
in-app terminal resolves its **own** checkout's binaries (e.g. `vp`) before
anything inherited from the server's `PATH` (which may point at a different
checkout). Upstream flattened `terminal/Layers/Manager.ts` → `terminal/Manager.ts`
and `createTerminalSpawnEnv` had dropped the `cwd` param and the
`withLocalNodeModulesBin` wrap.

Recovered: re-threaded `session.cwd` + `platform` (both already in scope at the
call site / `makeWithOptions`) into `createTerminalSpawnEnv` and wrapped the
return in `withLocalNodeModulesBin(spawnEnv, cwd, platform)` — the helper is still
exported from `@t3tools/shared/shell` with signature `(env, cwd, platform)`. Added
the import to `Manager.ts`.

### m2 — desktop `reasoningDisplay` fixture ✅

`apps/desktop/src/settings/DesktopClientSettings.test.ts` was missing the
now-required `reasoningDisplay` settings key (consequence of the fork's
`settings.ts` addition). Added `reasoningDisplay: "collapsed"` (the schema default,
`DEFAULT_REASONING_DISPLAY_MODE`) to the `clientSettings` fixture.

### DiffPanel `/api/vcs/diff` web cleanup ✅ (nothing to remove)

The fork's working-tree HEAD-diff web client (`fetchHeadDiff` + DiffPanel wiring)
was ACCEPT-DROPped during the merge and was **never re-applied** — a repo-wide
search finds **no** web/client-runtime references to `fetchHeadDiff` or
`/api/vcs/diff`. The clean drop means there is no dead web code to delete. The
**server** endpoint (`apps/server/src/vcs/http.ts`, `GET /api/vcs/diff`) is left
in place per brief (harmless; left untouched, not confirmed fully unused).

### m3 — doc correction (08 punch-list section d) ✅

Section (d) listed a phantom `buildThreadInterpretationPrompt` against
`hooks/useHandleNewThread.ts`. That helper is a **server**-side prompt builder
(`apps/server/src/textGeneration/…`), confirmed never present in the web hook in
either the fork or HEAD. The real web behaviour is threading an optional `goalId`
through `useHandleNewThread` (present and working in the merged tree); goal
**creation** (objective → `goal.create`) lives in the Sidebar context menu,
re-homed in Phase 2.5b. Corrected the punch-list row to reflect reality.

### Review docs committed ✅

`09-review-2.2-2.4.md`, `10-review-2.5.md`, `11-review-2.5b.md` committed (09 was
already tracked; 10 & 11 were untracked).

### Lockfile regen — no net delta ✅

`pnpm install` produced only transient, non-deterministic peer-dependency
resolution churn (e.g. `@react-native/metro-config` peer-arg reshuffling) that a
second `pnpm install` reverted. The committed `pnpm-lock.yaml` already matches the
merged manifests: `pnpm install --frozen-lockfile` **passes**. No lockfile change
committed. (The client-runtime `./accountUsage` subpath export is an `exports`
field — it does not affect the lockfile.)

### Mobile triage — MERGE-INDUCED, fixed ✅

`vp run typecheck` failed on 4 mobile errors. All four are **merge-induced** by our
Pi-first shared-type additions intersecting upstream's mobile files (these files do
not exist on the pre-merge fork `origin/main` — they arrived via the graft):

| File                                          | Error                                                                                | Cause                                                                                                         | Fix                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `features/archive/archivedThreadList.test.ts` | missing `goalId`, then all `withDecodingDefault` Pi fields; snapshot missing `goals` | our goal/workstream fields on `OrchestrationThreadShell` + `goals` on the shell snapshot                      | added the full Pi field set to the `makeThread` fixture (mirrors `lib/repositoryGroups.test.ts`) + `goals: []` to the snapshot |
| `features/home/homeThreadList.test.ts`        | same field gap on `EnvironmentThreadShell`                                           | same                                                                                                          | same fixture fill                                                                                                              |
| `native/T3ComposerEditor.ios.tsx`             | `Property 'value' does not exist` on the token union                                 | our `@thread` mention token variant (`{type:"thread", id, label}`, no `value`) added to `ComposerInlineToken` | handle the `thread` branch → use `token.label` (mirrors web `composer-logic`)                                                  |

`vp run lint:mobile` passes (it lints Swift/Kotlin only; the `.ios.tsx` change is
covered by typecheck).

## Verification results

| Check                            | Result                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `vp run typecheck`               | **GREEN** — 0 errors across all 15 packages (desktop fixed, all 4 mobile fixed)                          |
| `vp run lint:mobile`             | **PASS**                                                                                                 |
| `pnpm build` (production)        | **PASS** (exit 0) — `apps/server/dist`, `apps/web/dist`, desktop `dist-electron` all emitted             |
| `pnpm install --frozen-lockfile` | **PASS**                                                                                                 |
| `vp check` — formatting          | **GREEN** — fixed all flagged files (`ChatHeader.tsx` + `docs/upstream-sync/*`, the reviewer-noted debt) |
| `vp check` — lint                | **27 errors + 24 warnings remain — pre-existing, out of scope (see below)**                              |

### `vp check` lint debt — pre-existing convention drift, routed to Phase 2.7

After formatting was fixed, `vp check` surfaces 27 errors + 24 warnings that were
previously **masked behind the formatting failure** (vp check reports formatting
first and stops). These are NOT introduced by this tail phase — every flagged
location is in a file this phase did not touch, spanning ~24 Pi-feature files
(`orchestration/*`, `provider/Drivers/Pi/*`, `provider/Layers/Pi/*`,
`mcp/GoalHandoffHttp.ts`, `vcs/http.ts`, mobile `connection/*`, web `ChatMarkdown`,
`CommandPalette`, `ComposerQueuedMessages`, …).

Breakdown:

- **27 errors**: all the custom `t3code(namespace-node-imports)` rule (requires
  `import * as NodeFS from "node:fs"` etc. instead of named imports).
- **24 warnings**: `react(no-unstable-nested-components)` (13),
  `t3code(no-inline-schema-compile)` (7), `react(no-array-index-key)` (2),
  `eslint(no-unused-vars)` (1), `eslint(no-unsafe-optional-chaining)` (1).

**This is pre-existing fork code, not a re-home regression.** Verified directly:
the pre-merge fork (`6150362cf`) used the **same** named node imports
(`import { readFileSync } from "node:fs"`) in `roleOverlay.ts` / `threadResolve.ts`
— byte-identical to current. The errors are upstream's stricter lint conventions
applying to Pi code that never conformed.

**Decision:** left as documented out-of-scope. Fixing it is a 24-file
import-style + nested-component refactor of Pi feature code that (a) is exactly
"convention conformance", the explicit remit of **Phase 2.7** (independent review
of the merge), and (b) would balloon the tail diff and risk colliding with that
review. This mirrors the brief's own mobile-triage guidance ("if genuinely
pre-existing … record it as documented out-of-scope"). The brief's "vp check green"
bar was framed as a formatting problem; the masked lint debt is new information,
surfaced here for the orchestrator to route to 2.7.

## Live Pi-session smoke test — OWED TO HUMAN

Not performed. A real Pi-session smoke test requires the cockpit server running
with provider credentials and an actual Pi/model backend driving a live session —
none of which can be stood up straightforwardly or safely from this worktree. Per
AGENTS.md, a synthetic substitute is not an acceptable stand-in, so it is left
explicitly owed.

**Human smoke-test checklist (recommended):**

1. Start server + web (`pnpm cockpit:build` then open the web UI, or `pnpm dev`).
2. Create a new thread under a goal → confirm `goalId` threading works
   (new-thread hook) and the Sidebar goal-CRUD menus (create-from-thread / assign /
   archive / delete + confirm) behave (2.5b).
3. In the composer, type an `@thread` mention → confirm the workstream-ask flow and
   the mention token renders (web; ignore mobile native unless testing iOS).
4. Open an in-app **terminal** and run `vp --version` (or `which vp`) → confirm it
   resolves the worktree-local `node_modules/.bin` (M1).
5. Confirm reasoning tri-state display + spawn cards render in the timeline (2.5).
6. Sanity-check multi-session sidebar + workstream tree + account-usage pill.
