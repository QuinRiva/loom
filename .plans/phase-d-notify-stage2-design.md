---
manager_sessions:
  - id: e60766ea-eda2-46fa-9573-bc03cc432a2f
    role: plan
    authored_at: 2026-06-25T05:57:00.534Z
---

# Phase D-notify Stage 2: parent→child inspection tools (`read_child` + `ask_child`)

**Status:** design, ready to implement. Self-contained for a fresh thread (the
authoring thread's context is exhausted). The intent was specified in
`.plans/phase-d-notify-design.md` (the "communication layer", decision 6, and the
two-stage split); this doc makes Stage 2 implementation-ready.

**Prerequisite (merged):** D-notify Stage 1 — `workstream_report(markdown)` already
exists: a child records a markdown handoff stored as a file in a stable per-thread
dir, with a `reportPath` pointer on the thread record, surfaced to the parent's
wake message as a bounded summary + reference. Stage 2 builds directly on that.

## Why this exists
D-notify Stage 1 propagates a child's completion *up* to the parent with a bounded
summary + a `reportPath` reference. But the parent currently has **no first-class
way to (a) pull the full child report on demand, or (b) ask the child a clarifying
question** — it would have to hunt for a `.jsonl`. Stage 2 adds two parent→child
tools so the parent keeps a lean context and pulls detail only when needed:
1. **`read_child`** — passive: return the child's report/output/metadata on demand.
2. **`ask_child`** — active but **read-only (frozen oracle)**: answer a parent's
   question from a read-only snapshot of the child's session, without re-activating
   or mutating the child.

**Cross-dependency to flag:** the **D-liveness investigator (Stage 2 of that doc)**
needs to read a target child's transcript/output to judge real-work-vs-stuck-loop.
These tools are exactly that capability. Land Stage 2 **before** the D-liveness
investigator (the user's chosen sequence) so the investigator can build on
`read_child`/`ask_child` rather than inlining a one-off read.

## Resolved decisions
1. **`ask_child` = frozen oracle, NOT live-resume.** It reads a read-only snapshot
   of the child's session and answers; it never continues the child's turn or
   mutates it. Side-effect-free — no risk of re-activating a `done` child and having
   it wander off. (Decision 6 of the parent doc.)
2. **Auth = parent-of-the-target.** A credential may `read_child`/`ask_child` only on
   a thread it **directly parents** (mirror the existing
   `authorizationError(scopeThreadId, targetThreadId)` rule used by
   status/dependencies — `apps/server/src/mcp/WorkstreamSpawnHttp.ts` ~72). Both are
   read-only, but keep the parent-of scope for consistency and least-privilege; can
   be relaxed later if a use case appears.
3. **Additive, no schema migration.** Both tools read existing data (the Stage 1
   report file + the read-model thread detail/messages/activities). No new
   events/commands/columns.
4. **`read_child` returns the report + metadata; `ask_child` interrogates the
   transcript.** Keep the split clean: `read_child` is the cheap structured pull;
   `ask_child` is the LLM Q&A for anything not in the report.

## What to build

### Tool 1 — `read_child(threadId)`
- **Returns:** the child's full report markdown (via `readWorkstreamReport`,
  `apps/server/src/orchestration/workstreamReport.ts` ~43) **plus** key metadata
  from the read model (`getThreadDetailById`): role, title, current `status`,
  `reportPath` presence, and a compact recent-activity summary (last assistant
  message and/or last few activity rows). If no report was filed, say so explicitly
  and still return the metadata/last-output (never error-empty).
- **Auth:** parent-of-target (reuse `authorizationError`).
- **Server-side only:** the handler reads the file + read model on the server; the
  parent (possibly a remote client) never needs filesystem access.

### Tool 2 — `ask_child(threadId, question)`
- **Returns:** an answer derived from a **read-only snapshot** of the child's
  session, plus an honest "the child's session does not resolve this" escape when
  the transcript doesn't contain the answer (mirror the `consult_manager`/oracle
  pattern — don't fabricate).
- **Context source (open, see below):** the read-model thread detail
  (`getThreadDetailById` → messages) + activity projection
  (`ProjectionThreadActivities` `listByThreadId`) + the report. Recommend the read
  model first (already projected, no raw `.jsonl` parsing); fall back to the session
  `.jsonl` only if richer tool/reasoning detail proves necessary.
- **The LLM call:** a server-side read-only generation, modelled on the existing
  `TextGeneration` service (`apps/server/src/textGeneration/TextGeneration.ts`,
  used for title/branch generation) — same "server-side LLM call with a model
  selection from settings" pattern. Read-only; no orchestration command emitted.
- **Auth:** parent-of-target.

### Wiring (mirror the existing 4 workstream tools exactly)
- **MCP tool registration:** add `workstream_read_child` + `workstream_ask_child` to
  the pi extension (`apps/server/src/provider/Drivers/Pi/WorkstreamSpawnExtension.ts`)
  — same `callWorkstreamEndpoint` + `T3_WORKSTREAM_*_URL` + `T3_WORKSTREAM_
  AUTHORIZATION` pattern as `workstream_report`.
- **HTTP handlers:** add two routes in `apps/server/src/mcp/WorkstreamSpawnHttp.ts`
  beside the report handler (new path consts; `resolveWorkstreamScope` →
  `authorizationError` → do the work → JSON response). Export
  `workstreamReadChildUrlFromMcpEndpoint` / `workstreamAskChildUrlFromMcpEndpoint`.
- **Env wiring:** add the two `T3_WORKSTREAM_*_URL` vars in `PiDriver.ts` alongside
  `T3_WORKSTREAM_REPORT_URL` (inside the `withLocalNodeModulesBin(...)` mcpSession
  env block).
- **Tool descriptions / prompt guidance:** update the pi system prompt
  (`PI_WORKSTREAM_SYSTEM_PROMPT` in `PiDriver.ts`) to teach the parent it can pull a
  child's report (`read_child`) and ask a child clarifying questions (`ask_child`,
  read-only).

## Open decisions for the implementing thread
- **`ask_child` context source & size:** read-model messages+activities (cleaner)
  vs raw session `.jsonl` (richer tool/reasoning detail). A long child transcript
  may exceed the model context — decide a truncation/summarisation strategy (e.g.
  most-recent-N + the report, or a map-reduce summary). Recommend read-model +
  recency-truncation first.
- **`ask_child` model:** reuse `serverSettings.textGenerationModelSelection`, or a
  dedicated/configurable one? Add a **cost/length guard** (it's an LLM call per
  question).
- **`read_child` output shape:** exact metadata set + how much recent-activity
  summary to include (keep it lean — the point is to avoid bloating the parent).
- **Honesty contract for `ask_child`:** confirm the "snapshot doesn't resolve this"
  escape and whether to return a confidence indicator (mirror `consult_manager`).
- **Scope relaxation:** parent-of-target only (recommended) vs any ancestor — keep
  strict for v1.

## Out of scope
- Live-resume of a child (frozen oracle only — decision 1).
- D-liveness itself (separate signed doc) — but sequence this **before** its
  investigator.
- Any change to Stage 1's report storage/wake (already merged).

## Acceptance
- A parent calls `workstream_read_child(childId)` and gets the child's report +
  metadata **without filesystem access**; a non-parent credential is rejected
  (403); a child with no report still returns metadata/last-output, never errors
  empty.
- A parent calls `workstream_ask_child(childId, "<question>")` and gets an answer
  derived from the child's session, **read-only** — verified the child is neither
  re-activated (no new turn) nor mutated (no orchestration command emitted) — and an
  unanswerable question yields an honest "not resolved by the child's session"
  rather than a fabrication.
- Both tools appear in the pi tool surface with correct env wiring and the system
  prompt teaches them.
- `vp check` + `vp run typecheck` + server suite green. Cover the auth rule and the
  read-only guarantee with focused tests (note: new engine-backed Effect tests are
  infeasible per the tracked infra gap in
  `provider-intent-startup-reconciliation-design.md` — prefer pure-seam/HTTP-handler
  tests that run under the canonical `vp` runner).
- **Verify with a live pi run** if a server is available: spawn a child that files a
  report, then from the parent call `read_child` and `ask_child` and confirm real
  answers.

## References
- Stage 1 primitives: `apps/server/src/orchestration/workstreamReport.ts`
  (`readWorkstreamReport`, `workstreamReportFileName`, `workstreamReportsDir`),
  `apps/server/src/config.ts` (~89 `workstreamReportsDir`).
- Tool/handler/env pattern to mirror: `WorkstreamSpawnExtension.ts` (tool registry),
  `WorkstreamSpawnHttp.ts` (`resolveWorkstreamScope`, `authorizationError`,
  `getThreadDetailById`, the report route), `PiDriver.ts` (`T3_WORKSTREAM_*_URL`
  wiring + `PI_WORKSTREAM_SYSTEM_PROMPT`).
- Read-only LLM call pattern: `apps/server/src/textGeneration/TextGeneration.ts`.
- Oracle/honesty pattern to mirror: the `consult_manager` frozen-snapshot oracle
  (answers from a read-only prior session, may say "not resolved").
- Read-model context: `ProjectionSnapshotQuery.getThreadDetailById` (messages),
  `ProjectionThreadActivities.listByThreadId` (activity rows).
