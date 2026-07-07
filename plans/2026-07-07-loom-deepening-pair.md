---
manager_sessions:
  - id: f83f1494-12c5-48b9-a18c-71583fe29bda
    role: plan
    authored_at: 2026-07-07T12:04:18.723Z
---

# LOOM-ONLY deepening pair: receipt-dedup delivery module + MCP tool bridge collapse

Two independent deepening moves on fork-only file paths (none of these files exist upstream, so there is zero merge risk). Behaviour must be preserved exactly — these subsystems are the product's core delegation engine. Two coders can execute Move A and Move B in parallel with no file overlap (see §Sequencing).

Evidence base: server scout report §1.1–1.3 (`.pi-subagents/artifacts/07608c05_scout_0_output.md` in worktree `t3code-d436e9dd`), plus a fresh read of every site listed below.

Verification bar for both moves: `vp check` and `vp run typecheck` green; all existing tests pass (`vp test run` in `apps/server`); new through-the-interface tests added as specified.

---

## Move A — shared receipt-dedup delivery module

### A.0 The load-bearing fact the design rests on

The orchestration engine **already** receipt-dedups every command: `OrchestrationEngine.processEnvelope` (apps/server/src/orchestration/Layers/OrchestrationEngine.ts:164) looks up the command id in the receipt store before deciding, returning early on an accepted receipt. At-most-once is therefore an *engine* guarantee for any deterministic `server:` command id.

What the rails re-implement seven-ish times is the **bookkeeping convention around it**:

1. compute a deterministic episode-keyed command id;
2. check an in-memory handled-set (avoid re-reading receipts and re-building messages every pass);
3. fall through to the durable receipt on a cache miss (restart safety — the cache is only a cache);
4. deliver idle-gated (`requireIdle`) and catch `OrchestrationCommandDeferredError` as "not delivered, retry on next idle drain — record nothing";
5. only on real delivery: record the handled-set entry (and, for parent wakes, the rate-guard timestamp);
6. on a park/skip: record the handled-set entry **without** any receipt existing.

Step 6 is the documented hazard (WorkstreamDispatcher.ts:1109): the park path "poisons" `handledChildWakes` by adding a command id with no receipt behind it. Any rail that later asks "was X *actually delivered* to the parent?" must remember to consult the durable receipt, never the cache — today that is a comment-enforced discipline in the `recovered` branch.

### A.1 The current sites and how they actually differ

They are **not** identical. Survey (all fork-only files):

| # | Site | Command id | In-memory dedup | Receipt pre-check | Idle gate + defer-retry | Rate guard | Park path | Episode key / re-arm |
|---|------|-----------|-----------------|-------------------|--------------------------|------------|-----------|----------------------|
| 1 | Dispatcher `wakeEligibleParents` (delta rail), WorkstreamDispatcher.ts:944–1017 | Wake id is a **random** uuid; dedup is carried by per-child `childReportedCommandId` markers | `handledChildReports` | yes (marker), plus cross-rail receipt lookups in `alreadyNoticedByPriorRail` (:920–938) | yes (wake), wake-before-markers ordering | yes (per parent) | adds all batch markers to cache, no receipts | `terminalEpisodeKey` (outcome event id / spawnGeneration) |
| 2 | Dispatcher `wakeIdleAndErroredChildren` (per-child rail), :1085–1260 | deterministic `childWakeCommandId(child, episode)` | `handledChildWakes` | yes | yes | yes | adds command id to cache, no receipt — **the :1109 poisoning source** | per kind: `error` (once), `attention:<turnId>`, `idle:<maxSequence>`, `recovered` (once, keyed off the *durable* error-wake receipt), `slow-tool:<activityId>:<step>` |
| 3 | Dispatcher `routeGateTraversals`, :1256–1340 | deterministic `gateCommandId(source, round, leg)` | `handledChildWakes` (shared set, disjoint prefix) | yes | **no idle gate, no defer-catch** (gate serialises its parties by construction) | **no** | n/a | (source, round, leg) |
| 4 | Dispatcher `wakeYieldedChildren`, :1345–1428 | deterministic `yieldWakeCommandId(child, recordedByEventId)` | `handledChildWakes` | yes | yes | yes | adds command id to cache, no receipt | outcome event id (resume + re-yield re-arms) |
| 5 | Dispatcher `parkAndEscalate` (+ its two marker dispatches), :655–...:695 | deterministic park/block ids | none | none — relies on engine receipt idempotency alone | no | n/a (it *is* the guard action) | n/a | per-rail episode string |
| 6 | Fan-in reactor `deliverConflictNotice` / `deliverResolutionWake`, WorkstreamFanInReactor.ts:80–160 | deterministic per-child ids | none (engine receipt is the dedup) | none | yes — defer-catch returning a boolean | no | n/a | one per conflict / per resolution; `conflictedChildren` set is a process-scoped *episode tracker*, not a dedup cache |
| 7 | Liveness sweep `markDead` / `nudgeStall` / `escalateStall` / `adviseProgressLoop`, WorkstreamLivenessSweep.ts:349–520 | deterministic episode-keyed ids | none — `failureCounts` / `stallNudges` / `progressLoop` are **episode state machines** (counters, nudge timestamps, stashed context), not receipt caches | none — engine receipt idempotency | no (nudges steer an *open* turn; escalations raise flags) | no | n/a | `effectiveActivityMs` / `flatSinceMs` re-arm on progress |
| 8 | ProviderCommandReactor turn-start guard, ProviderCommandReactor.ts:239–257, :373 | `server:turn-start-fail:<turnStartKey>` | `handledTurnStartKeys` — a **TTL'd `Cache`** deduping provider *intent events*, not orchestration commands | n/a | n/a | no | n/a | turnStartKey |

Reading of the table: the genuinely shared protocol lives in rows 1–4 and 6 (the wake/notice deliveries). Rows 5, 7 and 8 look superficially similar but are different animals — see §A.4 for the explicit non-adoption rationale.

### A.2 Proposed module: `apps/server/src/orchestration/receiptDedup.ts` (new, LOOM-ONLY)

A small deep module whose interface structurally distinguishes "delivered durably" from "suppressed locally" — the distinction whose absence is the :1109 bug class.

```ts
export type DeliveryOutcome = "delivered" | "deferred" | "already-handled";

export interface ReceiptDedupedDelivery {
  /**
   * Skip check for a rail loop: true when this command id was delivered
   * durably (local record or accepted receipt) OR suppressed locally this
   * process (park/known-noise). Caches durable hits so receipts are not
   * re-read every pass.
   */
  readonly alreadyHandled: (commandId: string) => Effect.Effect<boolean>;

  /**
   * DURABLE-delivery check only: satisfied by a local delivery record or an
   * accepted receipt — NEVER by a local suppression. This is the primitive
   * for cross-rail "did the parent actually hear X?" questions (the
   * `recovered` rail, `alreadyNoticedByPriorRail`). The park path cannot
   * poison it by construction.
   */
  readonly wasDelivered: (commandId: string) => Effect.Effect<boolean>;

  /**
   * Deliver at most once: no-op ("already-handled") when handled; runs the
   * given dispatch effect otherwise. An OrchestrationCommandDeferredError is
   * caught and reported as "deferred" with NOTHING recorded, so the
   * deterministic id stays redeliverable on the next pass. Only a real
   * delivery is recorded (as delivered, durability backed by the engine's
   * receipt write).
   */
  readonly deliverOnce: <E, R>(
    commandId: string,
    dispatch: Effect.Effect<unknown, E, R>,
  ) => Effect.Effect<DeliveryOutcome, Exclude<E, OrchestrationCommandDeferredError>, R>;

  /**
   * Record as handled WITHOUT delivery — the explicit park/skip path. Local
   * only (a restart forgets it; the durable truth is that no receipt exists),
   * and invisible to `wasDelivered`. This is what today's raw set-adds on the
   * park paths do implicitly.
   */
  readonly markSuppressed: (commandId: string) => Effect.Effect<void>;
}

export const makeReceiptDedupedDelivery: (deps: {
  readonly hasAcceptedReceipt: (commandId: string) => Effect.Effect<boolean>;
}) => Effect.Effect<ReceiptDedupedDelivery>;
```

Implementation: two plain `Set<string>`s (`delivered`, `suppressed`) — safe because every consumer runs on a serial worker fibre, exactly like today's sets. `alreadyHandled` = delivered ∪ suppressed ∪ receipt (caching a receipt hit into `delivered`); `wasDelivered` = delivered ∪ receipt.

**Rate budget** (the `wakeTimestamps` map + `wakeRateGuardTrips` + park choreography shared by rails 1, 2, 4): extract as a second small export in the same file rather than folding into `deliverOnce` — the guard is a *per-parent* policy, orthogonal to per-command dedup, and the gate-traversal rail must be able to use `deliverOnce` without it:

```ts
export interface WakeRateBudget {
  /** Would one more wake for this parent trip the guard? Pure check, no mutation. */
  readonly wouldTrip: (parentId: string, now: number) => boolean;
  /** Record a real delivery against the parent's budget. */
  readonly recordDelivery: (parentId: string, now: number) => void;
}
export const makeWakeRateBudget: (config?: WakeRateGuardConfig) => WakeRateBudget;
```

`wakeRateGuardTrips` and `DEFAULT_WAKE_RATE_GUARD` stay exported from the dispatcher (they are tested pure exports); the budget composes them. The park *action* (`parkAndEscalate`) stays a dispatcher-local function — it is domain behaviour, not dedup plumbing.

Episode-key construction stays rail-side. The existing pure exports (`childWakeCommandId`, `yieldWakeCommandId`, `gateCommandId`, `childReportedCommandId`, `terminalEpisodeKey`) are the right locality: key discipline is per-rail semantics; the module takes a finished command id.

### A.3 Per-site adoption mapping

One `ReceiptDedupedDelivery` instance per dispatcher `make` closure replaces **both** `handledChildReports` and `handledChildWakes` (the ids are disjoint by prefix today and remain so); one `WakeRateBudget` instance replaces `wakeTimestamps`.

- **Site 2 — per-child wake rail: full adoption.** The tail of the loop (:1223–1250) becomes: `alreadyHandled(commandId)` → skip; parent-idle pre-filter (unchanged, rail-side); `budget.wouldTrip` → `parkAndEscalate` + `markSuppressed(commandId)`; else `deliverOnce(commandId, deliverChildWake(...))`, and on `"delivered"` → `budget.recordDelivery`. The `recovered` branch's guard (:1160) becomes `wasDelivered(childWakeCommandId(child.id, "error"))` — the :1109 comment is deleted because the wrong call no longer exists. The idle-wake-suppression check inside the `attention` branch (:1149–1153) likewise becomes `wasDelivered(idleWakeId)` (it asks "was the parent told", which today it approximates with cache-then-receipt).
- **Site 4 — yield rail: full adoption.** Same shape as site 2, minus classification.
- **Site 3 — gate traversal: `deliverOnce` only.** No idle gate, no defer-catch, no rate budget — pass the dispatch straight through (`deliverOnce` still swallows nothing except the deferred error, which this rail's commands never raise; a genuine dispatch failure still propagates to the pass-level `catchCause` exactly as today).
- **Site 1 — delta rail: partial adoption, deliberately.** The *wake* keeps its bespoke shape (random command id, batch-per-parent, wake-before-markers ordering) — do not force it through `deliverOnce`. What adopts the module is the per-child *marker* bookkeeping: `alreadyHandled(marker)` replaces the `handledChildReports.has` + `hasAcceptedReceipt` pair (:971–975); the park path's marker adds become `markSuppressed(marker)`; the cross-rail lookups in `alreadyNoticedByPriorRail` (:920–938) become `wasDelivered(...)` on the other rails' ids. After a delivered wake, `dispatchChildReportedMarker` runs as today and the marker is recorded via the module (a small `recordDelivered(marker)`-style path — acceptable as `deliverOnce(marker, dispatchChildReportedMarker(...))`, which reads naturally since the marker *is* a receipt-bearing command).
- **Site 6 — fan-in notices: `deliverOnce` adoption.** `deliverConflictNotice` / `deliverResolutionWake` keep their signatures but route through `deliverOnce` (mapping `"delivered"` → `true`, else `false`, preserving the boolean the callers branch on). This *adds* an in-memory skip the site currently lacks (today every conflicted pass re-dispatches and lets the engine receipt no-op it) — behaviour is identical, one engine round-trip cheaper. The `conflictedChildren` set is untouched: it tracks conflict *episodes* (so a resolution can be noticed), not deliveries.
- **Site 5 — `parkAndEscalate`: no adoption.** Its two writes rely on engine receipt idempotency and are unconditional by design (re-running the pass must be able to re-attempt them cheaply; there is no per-pass loop hammering them). Wrapping them buys nothing and obscures that the park is a domain action.
- **Sites 7 and 8: no adoption** — rationale in §A.4.

**Restart semantics are preserved by construction**: the module's sets are process-local caches; a fresh process recomputes the true handled set from receipts, exactly as the current comments promise. `markSuppressed` entries are forgotten on restart, matching today (a genuine runaway re-trips the guard and re-parks; the human was already alerted).

### A.4 Where the module should NOT be adopted, and why

- **Liveness sweep (site 7).** `failureCounts` (a consecutive-observation counter), `stallNudges` (episode signature + nudge timestamp + stashed transcript context) and `progressLoop` (fingerprint + flat-since clock + advised bit) are *state machines over evidence*, already extracted into pure, well-tested cores (`decideStallAction`, `decideProgressLoop`). Their maps re-arm on *progress*, not on receipts; forcing them into a delivery-dedup interface would distort both. The sweep's dispatches already carry deterministic episode-keyed ids and lean on engine receipt idempotency — the correct amount of machinery for actions that are guarded by the state machines above (each fires at most once per episode by construction). Adopting `deliverOnce` here would add ceremony and remove no bug class. The one genuinely shared thing — the `server:` id discipline — is a naming convention, not code.
- **ProviderCommandReactor turn-start guard (site 8).** `handledTurnStartKeys` dedups provider *intent events* (with a TTL, because the key space is unbounded), not orchestration command deliveries; `clearPendingTurnStartForFailedTurn` already gets idempotency from its deterministic id + engine receipt and needs its retry schedule. Different axis; leave alone.

### A.5 Optional sub-move: extract `classifyChildWakeFull` — include it, in a two-phase shape

The per-child wake loop's inline classification (:1120–1226) is the only part of the dispatcher whose logic (episode-key selection, grace gating, `recovered`/`slow-tool`/frozen-`attention` decisions) is reachable *only* through the full layer harness. Extracting it pays for itself: it concentrates every episode-key rule in one testable place and shrinks the loop to fetch-evidence → classify → deliver.

The wrinkle is that the inline branches fetch evidence *lazily* (freshness only for idle/attention/executing children; the in-flight-tool query only for slow-tool candidates; receipt lookups only for attention-suppression and recovered). A fully-pure classifier must not force those fetches for every child every pass. Shape:

```ts
// Pure. Phase 1: what evidence does this child's shape need?
export const childWakeEvidenceNeeds = (
  child: OrchestrationThreadShell,
  pendingTurnStartThreadIds: ReadonlySet<ThreadId>,
): ReadonlySet<"freshness" | "inFlightTool" | "idleWakeDelivered" | "errorWakeDelivered">;

export interface ChildWakeEvidence {
  readonly freshness?: { maxCreatedAt: string | null; maxSequence: number | null; heartbeatAt: string | null };
  readonly inFlightTool?: { toolName: string; startedAt: string; activityId: string } | null;
  readonly idleWakeDelivered?: boolean;   // wasDelivered(childWakeCommandId(id, `idle:<maxSequence>`))
  readonly errorWakeDelivered?: boolean;  // wasDelivered(childWakeCommandId(id, "error"))
  readonly provisionFailurePending: boolean;
  readonly waitingInGate: boolean;
}

// Pure. Phase 2: the full decision.
export type ChildWakeDecision =
  | { readonly kind: ChildWakeKind; readonly episode: string; readonly context?: ChildWakeContext }
  | { readonly skip: "healthy" | "within-grace" | "gate-waiting" | "already-notified" | "never-errored" | ... };

export const classifyChildWakeFull = (
  child: OrchestrationThreadShell,
  evidence: ChildWakeEvidence,
  now: number,
  pendingTurnStartThreadIds: ReadonlySet<ThreadId>,
): ChildWakeDecision;
```

The loop body becomes: needs → fetch exactly those (queries identical to today's, including the `wasDelivered` lookups) → classify → the §A.3 delivery tail. The existing pure `classifyChildWake` stays as the phase-2 entry step (it is exported and tested; `classifyChildWakeFull` composes it rather than duplicating it). The skip-reason variants make the previously comment-only suppressions (idle-wake-already-surfaced, gate-waiting, never-errored) assertable in unit tests.

**Escape hatch for the coder**: if wiring `evidenceNeeds` turns out to force extra queries or contort the flow, fall back to extracting only the branch bodies that are already evidence-complete (idle grace, frozen-attention, slow-tool step selection) and keep the fetch interleaving inline — the module adoption (§A.3) is the non-negotiable part of Move A; the classifier extraction is worth one honest attempt, not a death march.

### A.6 Files touched and test plan

New: `apps/server/src/orchestration/receiptDedup.ts`, `apps/server/src/orchestration/receiptDedup.test.ts`.
Modified: `orchestration/Layers/WorkstreamDispatcher.ts` (rails rewritten onto the module; net LOC should drop ~100–150), `orchestration/Layers/WorkstreamFanInReactor.ts` (two notice helpers), `WorkstreamDispatcher.test.ts` (additions only — see below).
Untouched: `WorkstreamLivenessSweep.ts`, `ProviderCommandReactor.ts`, `PiDriver.ts`, everything upstream-shared.

Tests:

1. **`receiptDedup.test.ts`, through the interface** with a stub `hasAcceptedReceipt`:
   - `deliverOnce` delivers once, then reports `already-handled`;
   - a deferred dispatch reports `deferred` and records nothing (a retry delivers);
   - `markSuppressed` makes `alreadyHandled` true but `wasDelivered` false — the poisoning class, stated as a test;
   - a fresh instance (simulated restart) with an accepted receipt reports handled + delivered;
   - `WakeRateBudget`: window/backstop trips per `wakeRateGuardTrips` semantics, deliveries recorded only when told.
2. **Existing suites must pass unchanged.** `WorkstreamDispatcher.test.ts` (~92 blocks) drives the layer through stubbed services and observes dispatched commands — it never reaches into the sets, so the refactor should be invisible to it. Same for `WorkstreamLivenessSweep.test.ts` (untouched file) and `WorkstreamFanInReactor.test.ts`.
3. **One new layer-harness regression for the :1109 class**: trip the rate guard so an `error` child-wake is parked (suppressed, no receipt); the child later reaches `done`; assert no `recovered` wake fires (the parent was never durably told about the error). This pins the exact behaviour the old comment defended.
4. If §A.5 lands: unit tests on `classifyChildWakeFull` covering each kind's episode key and each skip reason — these replace nothing (the harness tests stay) but make the branches directly assertable.

---

## Move B — collapse the 18-tool bridge

### B.0 Current shape (three hand-mirrored shallow layers)

1. **17 one-line URL builders**: `WorkstreamSpawnHttp.ts:585–620` (11), `GoalTaskHttp.ts:315–327` (5), `GoalHandoffHttp.ts` (1) — each `xUrlFromMcpEndpoint(mcpEndpoint)` applying the same strip-`/mcp`-suffix transform to a per-tool path constant that already exists (`SPAWN_PATH` etc., WorkstreamSpawnHttp.ts:112–122). The transform itself is copy-pasted into all three files.
2. **17 `T3_*_URL` env assignments** (18 vars counting `T3_WORKSTREAM_AUTHORIZATION`): `PiDriver.ts:1876–1905`, hand-mirroring list 1. The `mcp/*` import block (PiDriver.ts:52–75) exists solely to feed this — the only reason the *driver* depends on the MCP tool modules.
3. **Two extensions as JS-in-a-template-string**: `Drivers/Pi/WorkstreamSpawnExtension.ts` (477 LOC) + `GoalTaskExtension.ts` (214 LOC). Each tool re-declares its env var; `workstream_list`'s `execute` embeds ~60 LOC of real tree-rendering logic; **zero tests** — the largest untested fork surface after PiDriver.

Compatibility survey (grep across the repo, `roles/`, `skills/`, `docs/`, `AGENTS.md`, `CLAUDE.md`): the `T3_*_URL` names appear **only** in PiDriver, the two extension sources, and `.plans/*.md` (historical design docs — leave). `workstreamAsk.ts:86–88` strips env by the **prefix** `T3_WORKSTREAM_` (its test at `workstreamAsk.test.ts` asserts the prefix behaviour), so any replacement variable must keep that prefix. `T3_WORKSTREAM_AUTHORIZATION` is read by both extension sources and stripped by the fork — unchanged. Nothing else reads any of these names. There is no cross-version compatibility concern at all: the extension file is rewritten from the server's own build on **every** session launch (`ensurePi*Extension` writes unconditionally), so extension and server can never skew.

One incidental improvement worth noting in review: today the read-only consult fork strips `T3_WORKSTREAM_*` but not `T3_GOAL_*` — the goal tools only fail closed because the (stripped) authorisation is missing. After this move the goal tools ride the same `T3_WORKSTREAM_ENDPOINT`, so the prefix strip removes their transport too — strictly tighter isolation with no code change to `workstreamAsk`.

### B.1 Target design

**One env pair.** `T3_WORKSTREAM_ENDPOINT` (the base URL — the MCP endpoint with its `/mcp` suffix stripped) + the existing `T3_WORKSTREAM_AUTHORIZATION`. All 17 `T3_*_URL` variables and all 17 `xUrlFromMcpEndpoint` exports are deleted. The base-URL derivation (`mcpEndpoint.endsWith("/mcp") ? … : …`, currently pasted in three files) moves next to the path table and is the single helper PiDriver calls.

**A shared path table in a pure leaf module**: `apps/server/src/mcp/toolPaths.ts` (new, LOOM-ONLY). It imports **nothing** (types at most) and exports:

```ts
export const workstreamBaseUrlFromMcpEndpoint = (mcpEndpoint: string): string => …;

export const PROVIDER_TOOL_PATHS = {
  workstream_spawn: "/provider-tools/workstream/spawn",
  workstream_set_lane: "/provider-tools/workstream/lane",
  … // all 17, keyed by TOOL NAME
} as const satisfies Record<string, `/provider-tools/${string}`>;
```

- The HTTP modules (`WorkstreamSpawnHttp`, `GoalTaskHttp`, `GoalHandoffHttp`) delete their local `*_PATH` constants and register routes from this table — the compiler now connects "tool exists" to "route exists".
- PiDriver's `mcp/*` import block shrinks to this leaf plus the existing `McpProviderSession` leaf (28 LOC, already imported — the precedent that a *dependency-free constants leaf* under `mcp/` is fine; what gets severed is the driver's dependency on the 1,598-LOC handler module with its Effect layers and engine services). If the reviewer prefers a stronger statement, the leaf can live at `apps/server/src/providerToolPaths.ts` instead — contents identical; the coder may choose either, but must not re-introduce a PiDriver import of any HTTP handler module.

**Typed tool-definition tables + a generated extension.** Replace both `EXTENSION_SOURCE` template strings with data + a small generator in `provider/Drivers/Pi/`:

```ts
// provider/Drivers/Pi/providerToolDefs.ts  (new)
export interface ProviderToolDef {
  readonly name: keyof typeof PROVIDER_TOOL_PATHS;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: ReadonlyArray<string>;
  readonly parameters: Record<string, unknown>;       // JSON schema, verbatim from today
  /**
   * Error surface: "throw" makes a non-2xx a real pi tool error (the
   * workstream tools' documented requirement — a decider rejection must reach
   * the model as a failed call); "soft" returns error content (the goal
   * tools' current behaviour). Preserved per-tool, exactly as today.
   */
  readonly errorMode: "throw" | "soft";
  /**
   * Fallback text when the server response carries no `rendered` field —
   * a defensive one-liner only; the server render is the source of truth.
   */
  readonly fallbackText?: string;
}
export const WORKSTREAM_TOOL_DEFS: ReadonlyArray<ProviderToolDef> = [ … 11 … ];
export const GOAL_TOOL_DEFS: ReadonlyArray<ProviderToolDef> = [ … 6 … ];
```

The generator (`buildProviderToolExtensionSource(defs)`) emits one `.mjs` module: `JSON.stringify(defs-with-paths)` + a ~40-line generic runtime — read `T3_WORKSTREAM_ENDPOINT`/`T3_WORKSTREAM_AUTHORIZATION` once, and for each def `pi.registerTool({ …metadata, async execute(_id, params, signal) { POST base+path; print result.rendered ?? fallback; details: {ok:true,…result} } })`, honouring `errorMode`. All 17 tools' *metadata* (descriptions, schemas, guidelines) survives verbatim as typed TS data instead of string-embedded JS. Whether the output is one merged extension file or two (mirroring today's `t3-workstream-spawn-extension.mjs` / `t3-goal-task-extension.mjs`) is the coder's call — one file is simpler; if merging, keep passing a two-element `extensions` array being reduced to one in PiDriver and delete the stale second file name from the state dir opportunistically or leave it inert (it is no longer referenced).

**Rendering moves server-side.** Every handler's JSON response gains a `rendered: string` field carrying exactly the text the extension prints today; the extension becomes a dumb POST-and-print shim. Precedent already in-tree: `handleGoalTaskList` returns `rendered` (GoalTaskHttp.ts:118–123). Specifically:

- `workstream_list`: the ~60-LOC tree/model-catalogue renderer moves to a **pure exported function** `renderWorkstreamList(view): string` (in `WorkstreamSpawnHttp.ts` or a sibling `workstreamListRender.ts`), called by the handler. This is the untestable-logic centrepiece the move exists for.
- `consult_thread`: the candidate-disambiguation text becomes `rendered` on the unresolved response; the resolved response's `rendered` is the answer.
- `workstream_submit`: the disposition → prose mapping (done / needs_human / resolved / routed-rework / routed-reverify / yield-cap-breach / yield-unmatched) moves into the handler as a pure `renderSubmitOutcome(result): string`.
- The remaining one-line confirmations ("Spawned Workstream sub-thread X: title", "Set … plan lane to …", warnings appended): the handler composes them (including the `appendWarnings` suffix, which moves server-side). Each is a one-liner; the payoff is a uniform contract (`rendered` always present) that keeps the extension runtime generic.

The structured fields on each response are **unchanged and additive** — `details: { ok: true, ...result }` keeps exposing the same data to the UI/debug surface; `rendered` is a new sibling field, so nothing that reads the JSON today breaks.

### B.2 How the extension source obtains the path table

Codegen at build time via TS import — the tool-def module imports `PROVIDER_TOOL_PATHS` and each def's path is serialised into the generated source with `JSON.stringify`. No runtime lookup, no second env var, no duplication: the same constant that registers the HTTP route is baked into the extension text. (The alternative — the extension deriving paths by convention from tool names — was rejected: it would move the name→path mapping into stringly runtime code, exactly the shallowness being deleted.)

### B.3 Testability

The move makes three previously-untestable things testable; add tests for each:

1. **Path/route agreement** (`toolPaths` ↔ HTTP layers): a test that asserts every entry in `PROVIDER_TOOL_PATHS` has a registered route in the merged HTTP layer (or, minimally, that the per-module path lists consumed by `HttpRouter.add` are exactly the table's values — achievable by exporting the per-module route-path arrays and comparing).
2. **Server-side renderers as pure units**: `renderWorkstreamList` (tree shape, lineage indentation, waits-on lines, catalogue/presets block, the `(you)` marker, INVALID-preset marker), `renderSubmitOutcome` (all seven dispositions), consult candidate rendering. Fixtures lifted from the current extension logic so the output is character-identical to today.
3. **The generated extension, through its real interface**: a test that calls `buildProviderToolExtensionSource(...)`, writes it to a temp `.mjs`, dynamically `import()`s it, and invokes the default export with a **stub `pi`** (capturing `registerTool` calls) and a **stubbed `fetch`** + env. Assert: all 17 tools registered with the expected names/schemas; `execute` POSTs to `T3_WORKSTREAM_ENDPOINT` + the table path with the authorisation header; a 4xx **throws** for a `"throw"`-mode tool and returns error content for a `"soft"`-mode tool; the printed text is `result.rendered`. This one test covers what today is 691 LOC of dead-to-the-compiler string.

### B.4 Files touched

New: `mcp/toolPaths.ts` (or `providerToolPaths.ts`), `provider/Drivers/Pi/providerToolDefs.ts`, `provider/Drivers/Pi/providerToolExtension.ts` (the generator + `ensure*` writer), plus their `.test.ts` files.
Modified: `mcp/WorkstreamSpawnHttp.ts` (delete URL builders + local path constants; add `rendered` to handlers; export renderers), `mcp/GoalTaskHttp.ts` (same), `mcp/GoalHandoffHttp.ts` (same), `provider/Drivers/PiDriver.ts` (import block :52–75 and env block :1876–1905 collapse to two lines; extension wiring points at the generator).
Deleted: `provider/Drivers/Pi/WorkstreamSpawnExtension.ts`, `provider/Drivers/Pi/GoalTaskExtension.ts` (superseded).
Untouched: `orchestration/*` (including `workstreamAsk` — its prefix strip covers the new variable), `server.ts` (layer exports keep their names), everything upstream-shared.

`WorkstreamSpawnHttp.test.ts` (pure validation helpers) must keep passing — the helpers are untouched.

### B.5 Smoke verification (manual, after both `vp` gates pass)

Automated tests cannot exercise a real pi child loading the generated extension over a live MCP session, so the user should run one end-to-end pass on the rebuilt cockpit:

1. Rebuild + restart the Loom cockpit server; open a root orchestrator thread.
2. Spawn one trivial child (`workstream_spawn`) — verifies spawn round-trip + rendered confirmation text.
3. In the child (or root), call `workstream_list` — the rendered tree must look identical to before (indentation, `(you)` marker, model catalogue/presets block).
4. Call `goal_task_list` and `goal_task_add` — verifies the goal tools ride the new endpoint (and the soft error mode by calling one on a goal-less thread if convenient).
5. Have the child finish via `workstream_submit` — verifies the disposition prose and routing echo.
6. Spot-check the generated file at `<stateDir>/pi-extensions/` (single source of tool truth, contains the serialised path table) and that a child's env carries `T3_WORKSTREAM_ENDPOINT`/`T3_WORKSTREAM_AUTHORIZATION` and **no** `T3_*_URL` variables.
7. Optional: `consult_thread` with an ambiguous name — verifies the server-rendered candidate list.

---

## Sequencing and conflict analysis

**The moves are fully parallel.** File-set intersection is empty:

- Move A: `orchestration/receiptDedup.ts` (new), `orchestration/Layers/WorkstreamDispatcher.ts`, `orchestration/Layers/WorkstreamFanInReactor.ts`, their tests.
- Move B: `mcp/*`, `provider/Drivers/Pi/*`, `provider/Drivers/PiDriver.ts`, their tests.

Move A does not touch PiDriver; Move B does not touch any orchestration layer. The only shared symbol in the vicinity is `WORKSTREAM_CONTROL_PLANE_MARKER` (exported from the dispatcher, imported by the fan-in reactor) — both inside Move A's set. Two coders in isolated worktrees merge back without textual conflict; there is no semantic coupling either (Move B's HTTP handlers dispatch engine commands whose receipt behaviour Move A does not alter).

If run sequentially for any reason, order is indifferent. Neither move changes any wire contract, event shape, or upstream-shared file, so neither perturbs the other's tests.

**Shared verification bar (each coder, independently):** `vp check` green, `vp run typecheck` green, `apps/server` test suite green (existing `WorkstreamDispatcher.test.ts`, `WorkstreamLivenessSweep.test.ts`, `WorkstreamFanInReactor.test.ts`, `WorkstreamSpawnHttp.test.ts`, `workstreamAsk.test.ts` all unmodified-or-additive), plus the new tests in §A.6 / §B.3. Move B additionally carries the §B.5 manual smoke list for the user.

## Risks and behaviour-preservation notes

- **Move A** is a refactor of *bookkeeping*, not of delivery semantics: every command id, episode key, message builder, ordering rule (wake-before-markers), idle gate and defer-retry path is preserved verbatim. The two intentional non-behavioural deltas are (a) fan-in notices gaining an in-memory skip (saves a no-op engine round-trip on retried conflicted passes) and (b) the `recovered`/`attention` receipt lookups going through `wasDelivered` (same durable predicate, structurally enforced). Anything else that changes observable dispatch order or content is a bug.
- **Move B**'s rendered text must be character-identical to today's extension output — lift the strings verbatim into the renderers and pin them with the fixture tests. The per-tool error mode split (`throw` for workstream tools, `soft` for goal tools) is preserved exactly; unifying it is out of scope (flag it as a follow-up if desired).
- Both moves reduce total LOC (A: ~-100 net; B: ~-400 net after the def tables) — consistent with the fork's final-elegance bar.
