---
manager_sessions:
  - id: c1078458-460a-4291-9b90-e7ce1eb0ba39
    role: plan
    authored_at: 2026-06-24T10:33:57.258Z
---

# Plan: Split Workstream `purpose` into a short human summary + a full kickoff `brief`

## Problem

A spawned Workstream sub-thread carries a single `purpose` string that is doing
two incompatible jobs at once:

1. **The child's literal first-turn prompt.** `purpose` is fed verbatim into
   `workstreamChildPrompt({ role, purpose })` by the dispatcher
   (`apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts:75`). Because
   the child starts fresh with no inherited transcript, the spawn tool's schema
   and guidelines correctly tell agents to make `purpose`
   **"self-contained"** — so agents pour an entire multi-paragraph brief into it.
2. **The human-facing "Goal" label.** The sidebar card renders the same string
   in full under a "Goal" heading (`apps/web/src/components/WorkstreamPanel.tsx`
   ~588–592), and the card title defaults to `purpose` as well
   (`title = trimString(body.title) ?? purpose` in `WorkstreamSpawnHttp.ts:109`).

The result is the screenshot symptom: a "GOAL" block that is an entire wall of
prompt text, overflowing the card, defeating the point of an at-a-glance
purpose. The agents are not misbehaving — the data model conflates two concerns.

Note there is already a genuine high-level goal concept, `goalId`
(`OrchestrationThread.goalId`), which is the T3 goal that sits _above_ a thread
and is inherited from the parent. That is distinct from this per-sub-thread
purpose and is **out of scope**; this plan only fixes the per-thread field.

## Goal

Separate the two roles into two fields:

- **`purpose`** — a short (target 1–3 sentences) human-readable summary of why
  the sub-thread exists. This is what the sidebar card shows and what seeds the
  title. Required.
- **`brief`** — the full, self-contained kickoff prompt fed to the child on its
  first turn. Optional; when omitted, the child prompt falls back to `purpose`.

This keeps single-field ergonomics for trivial spawns (just a `purpose`) while
letting rich spawns supply a long `brief` without polluting the display.

## Design decisions (resolved)

These decisions are baked into this plan, **finalised after a full end-to-end
code review** (the review trimmed several over-broad propagation items — see the
"Resolved by review" notes).

1. **Field names: `purpose` (short) + `brief` (long).** `purpose` keeps its
   name but its _semantics_ change to "short summary"; `brief` is the new full
   prompt. `brief` was preferred over `prompt` because "prompt" already means the
   chat input box in this UI.
2. **`brief` is optional; child prompt uses `brief ?? purpose`.** A spawn with
   only a `purpose` still works — the short text becomes the prompt. The
   dispatcher's eligibility gate stays keyed on `purpose` being present
   (`selectThreadsToDispatch`); `purpose` remains required.
3. **No backwards compatibility / no dual-shape.** Per repo `AGENTS.md`, this is
   a prototype: we change the contract cleanly — no coexistence period, no compat
   field, no projector dual-write of `brief`/`purpose`.
4. **Migration: add the `brief TEXT` column only — no backfill, no truncation.**
   _Resolved by review:_ a legacy row (`brief = NULL`, long `purpose`) already
   produces the identical kick-off prompt today via the `brief ?? purpose`
   fallback, so backfilling `brief = purpose` changes nothing observable. Just
   add the guarded column.
5. **Manual-spawn UI stays purpose-only (YAGNI).** _Resolved by review:_ the
   split exists to tame _agent-generated_ walls of text, and agents spawn via the
   MCP tool, not this form. The new line-clamp protects the display even if a
   human types a long purpose. An optional `brief` textarea is a cheap follow-up
   if a real need appears; do not pre-build it.
6. **Defensive display clamp — Goal body only.** _Resolved by review:_ the card
   title is **already** `line-clamp-2` (`WorkstreamPanel.tsx:585`); only the Goal
   **body** (line 592) lacks a clamp. Add a clamp there and nowhere else. The
   `title={...}` hover-tooltip attributes (566/898) may keep the full purpose.
7. **`brief` is NOT propagated into the web read-model.** _Resolved by review:_
   `brief` is consumed in exactly one place — the server dispatcher reading
   `OrchestrationThreadShell`. It is never displayed, and the web
   `SidebarThreadSummary` types are hand-written (not schema-derived), so they
   need not mirror the contract. The only required web change is the Goal-body
   clamp.
8. **`brief` is added only to the spawn+dispatch path, not the detail/edit
   path.** _Resolved by review:_ `brief` lives on `OrchestrationThreadShell`
   (489), `ThreadCreateCommand` (613), `ThreadTurnStartBootstrapCreateThread`
   (697), and `ThreadCreatedPayload` (1161). It is deliberately **omitted** from
   `OrchestrationThread` detail (360), `ThreadMetaUpdateCommand` (657), and
   `ThreadMetaUpdatedPayload` (1200): there is no post-spawn brief editing for
   now. (If we later want re-dispatch parity with editable `purpose`, add it to
   those three then — a deliberate deferral, not an oversight.)

## Touch points

`brief` follows the spawn+dispatch slice of the `purpose` path only — contracts
(spawn-relevant schemas) → HTTP handler → decider → projector → projection shell
read → persistence → dispatcher. It is **not** propagated into the web read-model
or the detail/edit path (decisions 7 and 8). Line numbers confirmed by the
review.

### Contracts (`packages/contracts/src/orchestration.ts`)

Add `brief: Schema.NullOr(TrimmedNonEmptyString)` with a `null` decoding default
(mirroring `purpose`) to exactly these four schemas:

- `OrchestrationThreadShell` (489) — **load-bearing**: this is what the
  dispatcher reads.
- `ThreadCreateCommand` (613).
- `ThreadTurnStartBootstrapCreateThread` (697).
- `ThreadCreatedPayload` (1161).

Deliberately **not** added (decision 8): `OrchestrationThread` detail (360),
`ThreadMetaUpdateCommand` (657), `ThreadMetaUpdatedPayload` (1200).

### Server

- `apps/server/src/mcp/WorkstreamSpawnHttp.ts`: parse `brief` from the request
  body and pass it on the thread.create command. Validation: `purpose` required
  (as today), `brief` optional. The `title = trimString(body.title) ?? purpose`
  default needs **no change** — `purpose` is now the short field, so it already
  does the right thing.
- `apps/server/src/orchestration/decider.ts`: pass `brief` through on the
  thread.create spread.
- `apps/server/src/orchestration/projector.ts`: persist `brief` on create and
  update (the two `purpose` sites).
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`: `brief`
  passthrough alongside `purpose`.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`: map `brief`
  into **every shell-row mapper** (the dispatcher reads the shell). This is the
  one place a missed site silently breaks the feature — a new thread's shell
  would carry `brief = undefined` and quietly fall back to `purpose`.
- `apps/server/src/persistence/Services/ProjectionThreads.ts`: add `brief` to the
  row schema.
- `apps/server/src/persistence/Layers/ProjectionThreads.ts`: add `brief` to the
  INSERT column list, VALUES, and the `ON CONFLICT ... = excluded.brief` upsert.
- `apps/server/src/persistence/Migrations/039_*.ts` (new): add `brief TEXT`
  column guarded by a `PRAGMA table_info` existence check (mirror migration 037).
  **No backfill, no truncation** (decision 4).
- `apps/server/src/orchestration/workstreamChildPrompt.ts`: accept `brief`; the
  prompt body uses the brief. Single caller.
- `apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts`: the kick-off
  path destructures `{ role, purpose }` from the shell in `promoteThread` — also
  pull `brief` and pass `brief ?? purpose` to `workstreamChildPrompt`. The
  `selectThreadsToDispatch` eligibility filter stays keyed on `purpose`.
- `apps/server/src/provider/Drivers/Pi/WorkstreamSpawnExtension.ts`: add a
  `brief` parameter; **reword `purpose`** to "short (1–3 sentence) human-readable
  summary shown in the sidebar" and `brief` to "full self-contained prompt for
  the child's first turn (optional; defaults to purpose)". Update `description`,
  `promptSnippet`, and `promptGuidelines`. This is the _root-cause fix for the
  prompts that make agents write long purposes._ The `title ?? params.purpose`
  default needs no change (purpose is now short).
- `apps/server/src/provider/Drivers/PiDriver.ts`: update the Workstream banner
  text to mention the short purpose vs. full brief distinction.
- `apps/server/src/ws.ts`: bootstrap `createThread.brief` passthrough.

### Web (single change only — decision 7)

- `apps/web/src/components/WorkstreamPanel.tsx`: add `line-clamp` to the Goal
  **body** span (line 592). `getPurpose` already reads `purpose` (now short) and
  needs no change. The manual-spawn form stays purpose-only (decision 5).

Explicitly **not changed** (decision 7): `apps/web/src/types.ts`,
`apps/web/src/store.ts` (passthrough + equality comparisons),
`packages/client-runtime/src/threadDetailReducer.ts`, and the `brief: null` mock
churn in `ChatView.*` / `KeybindingsToast.browser.tsx`. `brief` is never read on
the client, and the hand-written `SidebarThreadSummary` types do not mirror the
contract, so decode tolerates the extra server-side field.

### Tests

- Add `brief: null` to fixtures **only for the four contract schemas that gain
  the field** (shell-bearing fixtures: projector/engine/snapshot/reaper/relay/
  server). Web/client-runtime fixtures are untouched since their types don't
  change.
- `WorkstreamDispatcher.test.ts`: extend the kick-off test to assert `brief`
  drives the prompt and that `brief`-absent falls back to `purpose`.

## Out of scope

- The high-level `goalId` concept and its display.
- Any change to dependency/`blockedBy` semantics.
- Re-labelling "Goal" in the card UI (the heading text) — optional polish, not
  required by this plan; can be decided during review.

## Verification

Per repo `AGENTS.md`: `vp check` and `vp run typecheck` must pass. Manually
exercise a spawn (short purpose only) and a spawn with a long brief, and confirm
in the sidebar that the card shows the short purpose while the child's first
turn receives the brief.

## Open questions — resolved by review

1. **Name:** keep `brief` (avoids clashing with "prompt" = the chat input box).
2. **Optionality:** keep `brief` optional with `brief ?? purpose` fallback — this
   is also what makes the no-backfill migration correct.
3. **Migration:** add the column only; no backfill, no truncation. The runtime
   fallback already makes legacy long-`purpose` rows produce the identical
   prompt.
4. **Manual-spawn UI:** stay purpose-only (YAGNI); the line-clamp protects the
   display.

The only item left to the user's discretion: whether to expose a `brief`
textarea in the GUI spawn form now rather than deferring it.
