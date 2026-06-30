---
manager_sessions:
  - role: analysis
    authored_at: 2026-06-30
---

# Upstream drift digest — baseline → nightly

_Phase 1 / Task C. Analysis only; no source changed. Australian English._

## Headline

- **Window:** baseline `477795697` (2026-06-14) → `upstream/main` `2448212` (2026-06-29, v0.0.28). **289 commits**, **1535 files** touched upstream.
- **The window is dominated by one programme of work, not features.** ~**203 of 289 commits (≈70%)** are a single Effect-idiom migration sweep: ~177 "[codex] Structure/Preserve/Sanitize … failures" error-modelling commits and ~26 "Refactor/align/normalize … Effect services" commits. These are broad-but-shallow per-module rewrites of error handling and service shapes. They touch a huge file count but are mechanically uniform.
- **The single most important merge finding: upstream has built NO sub-agent / delegation / goals / tasks / workstream / multi-agent-orchestration feature in this window.** The fork's signature Pi features have **no upstream counterpart to adopt** — they stay ours. (The only "agent" hits are _agent-awareness relay_ telemetry, unrelated.) See §4.
- **Biggest re-engineering target for the merge: the client-runtime "connection architecture" rewrite (#2978)** — it deleted the flat `wsTransport`/`wsRpcClient`/`*State.ts` modules the fork builds on and replaced them with `connection/`, `state/`, `relay/` subtrees. High impact, file layout moved wholesale. See §3.1.
- **Merge-relevant churn is concentrated in a handful of zones**; mobile/desktop (475 files) is high-volume but low-conflict for a web+server-focused fork.

## 1. Change distribution (files touched, upstream window)

| Area                                                       | Files | Merge relevance                                                                                   |
| ---------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `apps/web`                                                 | 398   | **High** — fork modifies the web shell (ChatView, Sidebar, CommandPalette, store, modelSelection) |
| `apps/mobile`                                              | 363   | Low — fork doesn't ship mobile                                                                    |
| `apps/server`                                              | 304   | **Medium/High** — fork's provider drivers, orchestration, runtime startup live here               |
| `packages/client-runtime`                                  | 166   | **High** — wholesale restructure; fork touches ws transport/protocol + addProject                 |
| `apps/desktop`                                             | 112   | Low — fork is web-first                                                                           |
| `infra`                                                    | 53    | Low                                                                                               |
| `packages/shared`                                          | 36    | **Medium** — fork touches `shared/model`; lots of new modules added                               |
| `packages/contracts`                                       | 28    | **Medium/High** — schema/contract drift; fork edits several contract files                        |
| `scripts`, `effect-acp`, `effect-codex-app-server`, others | ~50   | Low                                                                                               |

## 2. Theme A — the Effect-idiom migration sweep (≈70% of commits)

This is the defining characteristic of the window. Two intertwined campaigns, almost all authored by the `[codex]` bot:

### 2.1 Structured error modelling (~177 commits)

Every module that previously threw strings or loosely-typed errors was migrated to **`Schema.TaggedError` classes with preserved `cause` chains**. Representative: "Structure server runtime-state failures", "Preserve child process termination context", "Structure Claude adapter failures", "Sanitize text generation CLI errors". Supporting convention commits: "Enforce Effect error handling conventions" (#3380), "Add Effect service conventions check" (#3212), "Tighten structural Effect error checks" (#3213), "Preserve full cause chains in Effect error checks" (#3215).

- **Impact: medium, but pervasive.** Individually each is small; collectively they rewrite error-construction and `catch`/`catchTag` sites across nearly every server/shared module. Where the fork edited an error path in a shared file, expect _textual_ conflicts even though intent rarely clashes.
- **Merge tactic:** these are overwhelmingly **take-theirs** — the fork has no competing error model. The work is re-applying the fork's _behavioural_ edits on top of upstream's restructured error shapes, file by file, not adjudicating design.

### 2.2 Effect service-module normalisation (~26 commits)

"Refactor/align/normalize … Effect services" across persistence, source-control, terminal, preview, relay, desktop, client-runtime, text-generation. Standardises service definition style and **enforces namespace imports** ("Enforce canonical Node namespace imports" #3238, "Use namespace imports for desktop core services" #3207, "Remove redundant Effect type annotations" #3229).

- **Impact: medium.** Changes module _shape_ (how services are declared/wired), so any fork file that defines or consumes an Effect service may need its definition style realigned to pass the new convention checks.
- **Merge tactic:** adopt upstream's conventions; the new oxlint/`Effect service conventions` check will police fork-authored code too.

## 3. Theme B — architectural & feature changes that hit fork zones

### 3.1 Client connection architecture rewrite (#2978) — **HIGH impact**

`apps/desktop` + `apps/mobile` + `packages/client-runtime`. Replaced "saved environments" with a **connection catalog** abstraction and **restructured `packages/client-runtime` wholesale**:

- **Deleted:** `wsTransport.ts`, `wsRpcClient.ts`, `terminalSessionState.ts`, `vcsActionState.ts`, `vcsRefState.ts`, `threadDetailState.ts`, flat `managedRelay.ts` (and their tests).
- **Added:** `connection/{registry,supervisor,resolver}.ts`, `state/{runtime,vcsAction}.ts`, `relay/managedRelay*.ts`.
- **Why it matters for us:** the fork's client-runtime edits (`addProject`, ws transport/protocol) and several web-shell touchpoints sit on modules that **no longer exist at the same path/shape**. This is the merge's largest _re-engineer-onto-theirs_ zone — the fork delta must be re-expressed against the new connection/state layout, not 3-way-merged line-for-line.

### 3.2 Settings schema drift (`packages/contracts/src/settings.ts`) — **Medium/High**

The fork edits `settings.ts`. Upstream changed it: `diffWordWrap` → renamed `wordWrap` (default flipped to `true`); `autoOpenPlanSidebar` default flipped `true`→`false` (#2421); new `enableProviderUpdateChecks` and `newWorktreesStartFromOrigin` server settings; **`ServerSettingsError` restructured** (string `detail` → typed `operation`/`providerInstanceId`/`environmentVariable`, mandatory `cause`). Settings became **environment-scoped by default** (#3216), a web-heavy change touching ChatView, CommandPalette, Sidebar, `useSettings`, and state atoms — i.e. several of the exact files the fork's web shell modifies. Expect real conflicts here.

### 3.3 Contracts drift beyond settings — **Medium**

Large additive growth in `previewAutomation.ts` (+419), `project.ts` (+178), `assets.ts` (+170), `vcs.ts`, `terminal.ts`, `ipc.ts`, `preview.ts`, `editor.ts`, `rpc.ts` (+57). Mostly **new surface** for preview/file-browser/automation features (§3.5–3.6) — additive, low semantic conflict, but `rpc.ts` and `ipc.ts` are protocol files the fork may extend. **`orchestration.ts` itself changed by only +1 line** (`startFromOrigin` flag) — reassuring: the fork's heavy goals/tasks orchestration sits on a contract base upstream barely moved.

### 3.4 Server orchestration — **Low conflict, good news**

`apps/server/src/orchestration` saw only ~81/-77 lines, all Effect error-handling/test tweaks (CheckpointReactor, ProviderCommandReactor, Normalizer). The decider/projector/reactor event-sourcing engine the fork extends for goals/tasks is **essentially stable** across the window. The fork's orchestration additions should re-base cleanly.

### 3.5 Workspace file browser, preview panel & inline right panel — Medium (web shell)

A connected feature cluster landing through the window: "Add workspace file browser and preview panel" (#3087), "Render the plan surface in the inline right panel" (#3118), "Add right-panel bulk close and tab context menu actions" (#3116), "Improve inline panel, file preview, MCP session handling" (#3121), "Add file preview comments and task toggles" (#3115, +2585 lines: review annotations/comments — _code-review_ "tasks", not goal tasks), "Show disabled reasons for unavailable right-panel surfaces" (#3093), "Close right panel when its last tab closes" (#3221). These heavily rework `ChatView.tsx` and right-panel/layout components — **the same web-shell files the fork customises**. Medium-to-high textual conflict in `ChatView.tsx`.

### 3.6 Other notable features (mostly low conflict)

- "Add archived threads and mobile file viewer" (#3155); "Structure thread archive blocked error" (#3451) — thread archival; touches thread lifecycle the fork's sidebar cares about (Low/Medium).
- "Add main sidebar toggle" (#3497); "feat(sidebar): worktree indicator on session rows" (#3057); "Double-click a sidebar thread row to rename" (#3064) — Sidebar tweaks (Low/Medium — fork modifies Sidebar).
- "Restore chat scroll affordances and add timeline minimap" (#3587); chat-scroll stabilisation (#3564, #3545) — ChatView/timeline (Medium).
- "Add diff scope switching and provider update settings" (#3169); "feat: allow disabling provider update checks" (#3130); persistent word-wrap (#3480).
- "Add origin-based worktree bootstrap option" (#3157) — pairs with the `startFromOrigin`/`newWorktreesStartFromOrigin` contract additions.
- "Desktop: parallel WSL + Windows backends with mode picker" (#2751) — desktop only (Low).
- "Migrate desktop auth to Clerk bridge" (#3092); "Bump Clerk packages" (#3511) — auth/desktop (Low).
- "Use Effect schema decoders for JSON parsing" (#3060); "Use Effect schema decoders"-style hardening in shared.
- `packages/shared` gained many **new modules** (additive, low conflict): `chatList`, `composerInlineTokens`, `filePreview`, `httpReadiness`, `previewViewport`, `relayTracing`, plus growth in `logging`, `remote`, `schemaJson`, `dpop`, `relayAuth`/`relayJwt`. Net additive — main fork touchpoint `shared/model` is not in this set.

## 4. Overlap with fork-built features — the key adoption question

**Verdict: there is nothing in this upstream window to adopt in place of the fork's Pi features.**

- **Sub-agent / delegation / workstream / multi-agent orchestration:** _no upstream work._ Grep over all 289 subjects + diffs finds only "agent-awareness relay" (telemetry about which clients/agents are live for push/Live-Activity), which is unrelated to delegating work to child threads. The fork's workstream sub-thread system is unique.
- **Goals / task tree:** _no upstream work._ Upstream's "plan surface" / "task sidebar" / "task toggles" are a **different concept** — the agent's own plan/TODO display (Codex/Claude step list) and _code-review_ comment toggles (#3115/#3118/#2421). They are conceptually adjacent and **collide on UI real estate and naming** (right panel, "task sidebar" setting, `autoOpenPlanSidebar`) but do **not** implement goal/task management. Watch for store/atom and settings-key naming collisions during the merge, but keep the fork's goals/tasks implementation.
- **Multi-session GUI shell:** upstream continued evolving the _single_-session web shell (right-panel, file browser, scroll, sidebar) but did not build a multi-session shell. The fork's multi-session shell stays ours; the conflict is purely textual where both edited `ChatView.tsx`/`Sidebar.tsx`.
- **Provider/harness abstraction:** upstream's provider work in the window is the Effect error-restructure of adapters (Claude/Codex/OpenCode/text-generation) plus "missing provider command" structuring — no new provider abstraction layer. The fork's `PiDriver` / `builtInDrivers` additions face only the error-shape realignment of §2, not a competing abstraction.

**Implication for strategy (Task E input):** the merge is _adopt-theirs for plumbing, keep-ours for product_. Take upstream's Effect error model, service conventions, and the client-connection restructure as the new baseline; re-express the fork's small, well-isolated Pi delta (goals/tasks orchestration, PiDriver, multi-session/workstream UI) on top. No feature needs to be dropped in favour of an upstream equivalent — none exists.

## 5. Merge-impact summary

| Zone                                                      | Upstream change                                                                                 | Impact                 | Disposition                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| `packages/client-runtime`                                 | Connection-architecture rewrite (#2978): flat modules deleted → `connection/`/`state/`/`relay/` | **High**               | **Re-engineer fork delta onto new layout**                  |
| `apps/web` ChatView / right-panel / Sidebar               | File-browser, preview panel, plan surface, scroll, env-scoped settings                          | **High**               | 3-way merge; resolve textual conflicts, keep fork UX        |
| `packages/contracts/settings.ts`                          | Renames, default flips, `ServerSettingsError` restructure, env-scoping                          | **Medium/High**        | Merge; re-apply fork settings edits onto new schema         |
| Server error paths / Effect services (broad)              | ~203-commit Effect sweep                                                                        | **Medium (pervasive)** | **Take-theirs**; re-apply fork behaviour, adopt conventions |
| `packages/contracts` (preview/project/assets/vcs/ipc/rpc) | Large additive feature surface                                                                  | **Medium**             | Mostly additive; watch `rpc.ts`/`ipc.ts`                    |
| `apps/server/src/orchestration`                           | Effect tweaks only (+81/-77)                                                                    | **Low**                | Fork orchestration re-bases cleanly                         |
| `packages/shared`                                         | Many new modules + hardening                                                                    | **Low**                | Additive; `shared/model` untouched upstream                 |
| `apps/mobile`, `apps/desktop`                             | Connection catalog, Clerk, WSL backends                                                         | **Low**                | Out of fork's scope                                         |
| Pi features (goals/tasks/workstream/PiDriver)             | **No upstream equivalent**                                                                      | n/a                    | **Keep ours; re-base onto new baseline**                    |

## Reproduce

```sh
B=477795697d8546a8db4903bd878a5ad3196423b9
git log --oneline $B..upstream/main | wc -l                       # 289
git diff --name-only $B..upstream/main | wc -l                    # 1535
git log --format='%s' $B..upstream/main | grep -ciE "error|failure|preserve|sanitize|enrich|diagnos"  # ~177
git log --format='%h %s' $B..upstream/main | grep -iE "agent|delegat|subagent|goal|workstream"        # only agent-awareness relay
git show --stat e95b57dc2   # client connection rewrite (#2978)
git diff $B..upstream/main -- packages/contracts/src/settings.ts
git diff $B..upstream/main -- packages/contracts/src/orchestration.ts   # +1 line
```
