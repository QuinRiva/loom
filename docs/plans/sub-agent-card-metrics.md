---
manager_sessions:
  - id: c4b6bc1d-ad14-4838-9450-71104094c9d7
    role: plan
    authored_at: 2026-06-29T09:02:21.202Z
---

# Implementation Plan — Sub-agent card metrics display

## Goal

Surface useful per-sub-agent metrics on the Workstream **board cards**
(`WorkstreamPanel.tsx`) so an orchestrator can, at a glance, judge each child's
**cost**, **configuration (model)**, and **effort/health**, and drill into a
fuller breakdown on demand.

This plan implements the design agreed in the design session:

- **Show:** cost (headline), model (chip), effort/tool-calls + context-window %
  (health), report-ready (triage). **Detail-on-demand** popover for the full
  breakdown.
- **Do NOT show:** raw token totals (redundant with cost — use context-window %
  instead) and **lines of diff** (children inherit the parent's
  `branch`/`worktreePath`, so multiple children edit the same worktree and git
  cannot attribute lines per-thread — the number would be misleading). If a
  change-size signal is later wanted, derive "edits made" from the child's own
  edit/write tool activity, not git lines.

## Background — what already exists (do not rebuild)

- **Cost** is already on the board: `SidebarThreadSummary.cumulativeCostUsd`,
  folded server-side by `deriveCumulativeCostUsd` in
  `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (sums each
  `context-window.updated` activity's `costUsd`). It is written to the
  `projection_threads.cumulative_cost_usd` column and read back into the shell
  snapshot (`ProjectionSnapshotQuery.ts`, aliased `AS "n"`/`cumulativeCostUsd`).
- **Model** is already on the wire shell (`OrchestrationThreadShell.modelSelection`,
  stored in `projection_threads.model_selection_json`) and on the web `ThreadShell`
  — but it is **not** copied into `SidebarThreadSummary`, which is what the cards
  read.
- **Context-window snapshot** (`usedTokens`, `maxTokens`, `inputTokens`,
  `outputTokens`, `toolUses`, `durationMs`, …) is carried by the latest
  `context-window.updated` activity. `deriveLatestContextWindowSnapshot` in
  `apps/web/src/lib/contextWindow.ts` already parses it, and `ContextWindowMeter.tsx`
  already renders a donut+popover for it in the chat header — but only from the
  **full thread's** `activities`, which are **not** present on the board projection.
- **Cost rollups** across a subtree already exist:
  `subtreeCostOf`/`descendantsOf`/`childrenOf` in
  `@t3tools/shared/workstreamGraph`, used by `deriveContextCostSummary`.
- **Report-ready**: `OrchestrationThreadShell.reportPath` is on the wire but not
  on `SidebarThreadSummary`.
- **Formatters** already exist: `formatCostUsd`, `formatContextWindowTokens` in
  `apps/web/src/lib/contextWindow.ts`.

## Data-availability tiers (gates the phasing)

| Metric                       | Source today                                   | Work to surface on a card                               |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Cost ($)                     | `summary.cumulativeCostUsd`                    | none (already present)                                  |
| Model                        | shell `modelSelection` (not on summary)        | copy into summary + formatter                           |
| Report-ready                 | shell `reportPath` (not on summary)            | copy into summary                                       |
| Tool-calls / ctx% / duration | only in `activities` (not on board projection) | server fold into new columns, then onto shell + summary |

---

## Phase 1 — Model + cost chips (frontend only, no server change)

**Outcome:** each card shows a slim footer line with a **model chip** and a
**cost chip**. Cost is the card thread's own spend; when the card thread has
descendants, show the subtree total instead (mirrors the chat meter's headline
rule).

**Files:**

1. `apps/web/src/types.ts` — add to `SidebarThreadSummary`:
   - `modelSelection: ModelSelection` (import the type; it is already imported in
     this file for `ThreadShell`).
   - `reportPath: string | null` (cheap, enables the report-ready signal now and
     in Phase 3).
2. `apps/web/src/store.ts` — in the `summary` object built inside
   **`mapThreadShell`** (function at `store.ts:291`; summary object at
   `store.ts:327` — the plan's earlier "`toThreadParts`" name was wrong), map
   `modelSelection: normalizeModelSelection(thread.modelSelection)` and
   `reportPath: thread.reportPath ?? null`. (`normalizeModelSelection` is already
   used a few lines above for the shell; `thread` here is an
   `OrchestrationThreadShell`, which already carries both fields — confirmed
   `contracts/orchestration.ts:526-575`.) **Also** add the new fields to
   `sidebarThreadSummariesEqual` (`store.ts:448-477`) — it is the _sole_ gate
   before `sidebarThreadSummaryById` is written (`store.ts:819-831`), so fields
   omitted there will not update the board live. This is the only summary-mapping
   site (the detail-stream `writeThreadState` path does not rebuild the summary).
3. `apps/web/src/lib/workstreamPresentation.ts` — add a pure
   `formatModelLabel(selection: ModelSelection): string` that returns a short
   display name from the model slug (e.g. `openai/gpt-5.5` -> `gpt-5.5`,
   `google-vertex-claude/claude-opus-4-8` -> `claude-opus-4-8`). Take the
   segment after the last `/`. Keep it JSX-free (this module is shared with the
   graph chunk).
4. `apps/web/src/components/WorkstreamPanel.tsx` — in `WorkstreamCard`, add a
   footer metric row (after the existing status/branch badge row, before the
   Status `<select>` divider, or merged into the existing
   `mt-3 flex flex-wrap … gap-1.5` badge row). Render:
   - a model chip (mono, muted, same visual family as the existing `branch`
     chip), and
   - a cost chip using `formatCostUsd` showing **this card thread's own cost**
     (`thread.cumulativeCostUsd`). When `formatCostUsd` returns `null`
     (zero/unknown cost), render nothing for the cost chip. **Do not** put the
     subtree roll-up on the card face: replicating the chat-meter's
     "own-or-subtree" headline onto every card makes a mid-tree parent's subtree
     total visually overlap its children's own-cost chips elsewhere on the same
     board, reading as double-counting. The subtree roll-up (own vs subtree,
     per-branch) belongs in the Phase 3 popover where it can be labelled — the
     chat meter gets away with an unlabelled headline only because it is a single
     focused thread, not a grid of peers. (`subtreeCostOf`/`childrenOf` from
     `@t3tools/shared/workstreamGraph` are used there, not here.)

**Verification:** `vp check` + `vp run typecheck`; load the board with a running
workstream and confirm chips render and update.

---

## Phase 2a — Server fold: tool-calls + context-window snapshot (backend only)

**Outcome:** the board projection carries, per thread, the latest
context-window-derived effort/health figures so cards (Phase 2b) can show them
without loading full activities. Mirror the existing `cumulative_cost_usd`
plumbing exactly.

Decide the **minimal** column set to fold (recommendation): `tool_uses`
(INTEGER), `used_tokens` (INTEGER), `max_tokens` (INTEGER). These give the
"effort" counter and the context-window %. `duration_ms` is optional/nice-to-have
for Phase 3 — include it only if cheap. All NULL/0-defaulted and additive.

**Files (follow the `cumulative_cost_usd` template end-to-end):**

1. **Migration** — new `apps/server/src/persistence/Migrations/042_ProjectionThreadContextMetrics.ts`,
   modelled on `041_ProjectionThreadCumulativeCost.ts`: `PRAGMA table_info` guard
   then `ALTER TABLE projection_threads ADD COLUMN …` for each new column
   (**INTEGER, NULL** default — unknown for non-pi threads / before first
   activity; deliberately distinct from cost's `REAL NOT NULL DEFAULT 0` so the
   UI can suppress the chip rather than show a misleading `0`). **Registration is
   two edits in `apps/server/src/persistence/Migrations.ts`:** a static
   `import Migration0042` **and** a `[42, "…", Migration0042]` tuple in the
   `migrationEntries` array. Doing only one half silently no-ops the migration.
2. `apps/server/src/persistence/Services/ProjectionThreads.ts` — add the columns
   to the `ProjectionThreadDbRow` schema and the upsert input type.
3. `apps/server/src/persistence/Layers/ProjectionThreads.ts` — add the columns to
   the INSERT column list, `VALUES`, `ON CONFLICT … DO UPDATE SET`, and **all**
   SELECT projections (`getProjectionThreadRow`, `listProjectionThreadRows`, and
   any others in this file).
4. `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`:
   - Add a `deriveContextMetrics(activities)` helper that walks activities
     **newest-first**, finds the latest `context-window.updated` with a valid
     payload, and returns `{ toolUses, usedTokens, maxTokens }` (numbers or
     null). This mirrors `deriveLatestContextWindowSnapshot` (web) but server-side
     and minimal; reuse the same payload keys (`toolUses`, `usedTokens`,
     `maxTokens`).
   - In `refreshThreadShellSummary` (where `cumulativeCostUsd =
deriveCumulativeCostUsd(activities)` is computed and passed to `upsert`),
     also compute and pass the new fields. Note the **semantic difference**: cost
     is a _sum_ over all activities; these metrics are _latest-snapshot_ (the
     newest `context-window.updated` payload). Both are deterministic on replay
     (durable, ordered activities), but the metrics do not accumulate — do not
     "fix" them into a sum. `toolUses` is the provider's running session total
     (`usage.tool_uses`, e.g. `ClaudeAdapter.ts:570`), i.e. exactly what the
     existing chat-header `ContextWindowMeter` shows — keep it as that total, not
     a per-turn delta.
   - In the `thread.created` upsert path (which seeds `cumulativeCostUsd: 0`),
     seed the new fields as `null`.
5. `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — **mirror
   every `cumulativeCostUsd` occurrence (grep returns 10, not 4):** 4 SELECT
   alias sites (`:472, 510, 550, 955`) **plus 6 object-assembly sites**
   (`cumulativeCostUsd: row.…` / `threadRow.value.…` at
   `:1532, 1765, 1947, 2093, 2378, 2484`). Following only the "4 SELECT alias"
   sites silently drops the new metrics on 6 of the assembled shells.
6. `packages/contracts/src/orchestration.ts` — add the new fields to
   **`OrchestrationThreadShell`** (and, for parity, `OrchestrationThread`).
   Because the metrics must be **null when unknown** (not 0), use the
   **`lastActivityPreview` template**
   `Schema.NullOr(…).pipe(Schema.withDecodingDefault(Effect.succeed(null)))`
   (`orchestration.ts:571-573`) — **not** `cumulativeCostUsd`'s bare
   `Schema.optional(NonNegativeNumber)` (`:556`), which carries 0/absent
   semantics. Additive + decode-default so old snapshots still decode.

**Verification:** `vp check` + `vp run typecheck`; run the server, exercise a pi
sub-thread, and confirm the columns populate (sqlite query or snapshot payload).
This phase is independent of Phase 1 (no shared files) and can run in parallel.

---

## Phase 2b — Effort + context-health chips (frontend; depends on 2a)

**Outcome:** the card footer also shows a tool-calls counter (e.g. `42 tools`)
and a context-window % indicator (e.g. `38%`), from the new summary fields.

**Files:**

1. `apps/web/src/types.ts` — add the new numeric fields to `SidebarThreadSummary`.
2. `apps/web/src/store.ts` — map them into the `summary` object inside
   `mapThreadShell` (+ `sidebarThreadSummariesEqual`, as in Phase 1).
3. `apps/web/src/lib/workstreamPresentation.ts` — add a `formatContextPercent`
   (or reuse a small helper) and reuse `formatContextWindowTokens` for the
   counter where useful.
4. `apps/web/src/components/WorkstreamPanel.tsx` — extend the footer row with the
   effort + ctx% chips. Suppress each chip when its value is null/0.

**Note:** must land after 2a (no data otherwise) and edits the same card footer

- summary as Phase 1 — serialise the frontend work to avoid conflicts.

---

## Phase 3 — Detail-on-demand metrics popover (optional; depends on 1 + 2a)

**Outcome:** a small affordance on each card (donut or "metrics" icon) opens a
popover with the full breakdown: cost own/subtree (+ per-branch via existing
`deriveContextCostSummary`), context-window % + used/max tokens, tool-calls,
duration, full model name, and report-ready.

**Approach:** reuse the existing `ContextWindowMeter.tsx` visual idiom (donut +
`Popover`/`PopoverPopup`) for consistency. Either parameterise/extract a shared
presentational popover or build a small board-specific one that reuses the same
formatters and the `Popover` primitives. Keep it the last frontend change so it
consolidates whatever Phases 1 + 2 exposed.

---

## Dependencies & execution order

- **Parallel:** Phase 1 (frontend) ∥ Phase 2a (backend) — disjoint files.
- **Serial:** Phase 2a → Phase 2b (hard data dependency).
- **Serial (file-coupling, not logic):** Phase 1 → Phase 2b → Phase 3 all edit
  the card footer + `SidebarThreadSummary` + `store.ts` mapping, so the frontend
  work is done in one hand in sequence.
- True blocker edge: **2a → 2b**. Everything else is independent or same-hand.

Recommended: kick off Phase 2a as a delegated backend coder; do Phase 1 in
parallel; then Phase 2b (after 2a); then Phase 3 last (optional).

## Non-goals / explicitly excluded

- Lines-of-diff (ill-defined under shared worktrees — see Goal).
- Raw token totals as a card metric (use context-window % instead).
- Pricing tokens ourselves — only the provider-authoritative `costUsd` is used,
  consistent with the existing meter.

## Risks / watch-items for the reviewer

1. **Summary diff suppression:** `store.ts` has equality helpers that gate board
   re-renders; new summary fields must be included or chips won't update live.
2. **Migration registration:** confirm the exact mechanism that discovers/runs
   numbered migrations and that `042` is wired in.
3. **Null vs 0 semantics:** cost defaults 0 (meaningful); tokens/tool-uses should
   be **null** when unknown (non-pi providers, no activity yet) so the UI can
   suppress the chip rather than show a misleading `0`.
4. **Shared-vs-own cost on cards — RESOLVED:** card face shows **own cost only**;
   the subtree roll-up (labelled own vs subtree, per-branch) lives in the Phase 3
   popover. This avoids an unlabelled subtree total on a mid-tree parent's card
   visually double-counting against its children's own-cost chips elsewhere on
   the board.
5. **Bundle hygiene:** `workstreamPresentation.ts` is shared with the lazily
   loaded graph chunk — keep new helpers JSX-free and dependency-light.
   </content>
   </invoke>
