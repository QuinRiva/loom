---
manager_sessions:
  - id: 371bc7ea-f2c3-402c-8508-c8459eccaeb5
    role: plan
    authored_at: 2026-07-07T12:38:32.239Z
---

# Fork seam-narrowing campaign — contracts, decider/projector, server wiring

_Loom (fork of `pingdotgg/t3code`, remote `upstream`) must keep merging upstream with
minimal conflicts. This plan relocates fork additions out of upstream-owned files into
fork-owned siblings, leaving one-line splice points behind. Merge-base with
`upstream/main`: `600972084`. Background: `docs/upstream-sync/`._

## How to read this document

Three independent slices, each executable by a separate coder without reading the
others in depth:

- **Slice A** — contracts splice seam (`packages/contracts/src/orchestration.ts`, `settings.ts`)
- **Slice B** — decider/projector delegation (`apps/server/src/orchestration/decider.ts`, `projector.ts`, `commandInvariants.ts`) — **depends on Slice A**
- **Slice C** — server composition seam (`apps/server/src/server.ts`, `serverRuntimeStartup.ts`, `ws.ts`) — independent, may run in parallel with A

Shared rules and the verification bar are in §0. The splice mechanics in §A.2 were
**compile-, runtime- and merge-verified by throwaway spikes** in this worktree
(details in §A.2.6) — coders do not need to re-derive them.

---

## 0. Non-negotiables (all slices)

1. **No behavioural change anywhere.** This campaign is pure code relocation. Every
   command, event, decode, layer, and route behaves byte-for-byte identically.
2. **Never refactor upstream-only logic.** Only fork additions move. Where a fork
   change *modifies* upstream lines (listed per slice as "residuals"), it stays put.
3. **No renaming of exported contract types.** Every exported identifier keeps its
   name and remains importable from `@t3tools/contracts` (the package root). Moved
   declarations are re-exported via `index.ts`.
4. **Event/command `type` strings never change.** Persisted events must decode
   identically; discrimination is by the `type` literal, which is order-independent
   in `Schema.Union`/`Schema.Literals` (members are disjoint), so moving fork members
   into a single spread — at any position — is decode-safe.
5. **File naming convention:** fork siblings use a `.loom.ts` suffix next to the
   upstream file (`orchestration.loom.ts`, `decider.loom.ts`), except the server
   composition module which lives in a fork-owned directory `apps/server/src/loom/`.
6. **Residual marker convention:** every fork edit that must remain inside an
   upstream-owned file gets a `// loom:` comment on (or immediately above) the edited
   line(s), so future merge conflicts are self-identifying. Splice lines (spreads)
   count as residuals and get the marker too.
7. **Verification bar per slice:** `vp check` and `vp run typecheck` green, plus the
   slice-specific acceptance checks. After each slice, run
   `git diff 600972084 -- <upstream file>` and confirm the remaining hunks match the
   residual inventory listed here — anything extra is scope creep.
8. **Out of scope entirely:** `ProjectionSnapshotQuery.ts`, `ProviderRuntimeIngestion.ts`
   (both flagged UPSTREAM-ENTANGLED), `packages/contracts/src/server.ts`, `rpc.ts`,
   `providerRuntime.ts`, `model.ts` (their fork deltas are additive and not in this
   campaign), and everything under `apps/web`.

---

## Slice A — contracts splice seam

### A.1 Outcome

`packages/contracts/src/orchestration.ts` drops from **+1001/−2 across ~41 hunks** vs
the merge-base to roughly **19 one-line splice points + a handful of marked residual
one-liners**. `settings.ts` drops from ~25 hunks to ~8. All fork schema declarations
live in two new fork-owned files:

- `packages/contracts/src/orchestration.loom.ts`
- `packages/contracts/src/settings.loom.ts`

`packages/contracts/src/index.ts` gains one line: `export * from "./orchestration.loom.ts";`
(and one for `settings.loom.ts` if it exports anything consumed outside — it does:
`ReasoningDisplayMode`, `ProviderFailoverSettings`). Marked `// loom:`.

### A.2 Mechanics (proven — see §A.2.6)

**Hard constraint: `orchestration.loom.ts` must not value-import `orchestration.ts`.**
The dependency is strictly one-way (`orchestration.ts` → `orchestration.loom.ts`),
because both files evaluate their schema unions at module init — a value cycle is a
TDZ crash. Type-only imports (`import type { OrchestrationCommand }`) are fine (erased
at runtime). Everything the loom file needs at value level comes from `baseSchemas.ts`,
`providerInstance.ts`, `providerRuntime.ts` and `effect` — verified: no moved
declaration references an upstream `orchestration.ts` value except `EventBaseFields`,
which is handled by the factory in (d).

Five splice shapes, all typechecked against this repo's Effect Schema:

**(a) Union member spread.** Fork members are exported as `as const` tuples and spread
once **immediately after the opening bracket** of the upstream union literal (HEAD
position, not tail):

```ts
// orchestration.loom.ts
export const LoomClientCommandMembers = [GoalCreateCommand, /* … */] as const;

// orchestration.ts — the upstream literal keeps its members; one line added FIRST:
export const ClientOrchestrationCommand = Schema.Union([
  ...LoomClientCommandMembers, // loom:
  ProjectCreateCommand,
  /* …upstream members unchanged… */
  ThreadSessionStopCommand,
]);
```

**Why head, not tail — merge-tested.** Upstream's own union edits are predominantly
tail appends. A `git merge-file` simulation (base `[A, B]`) shows a **tail** splice
conflicts with an upstream tail append (`[A, B, C]` vs `[A, B, ...Loom]` → conflict
at the tail), while a **head** splice merges cleanly (result
`[...Loom, A, B, C]`). The head splice conflicts only on an upstream *head*
insertion, which is rare — and any residual conflict is self-identifying via the
`// loom:` marker. Member order is decode-irrelevant here: every union in scope is
discriminated by disjoint `type`/`kind` literals, so "first match wins" cannot
change outcomes (locked by the contracts/decider test suites).

Do **not** rename upstream unions or tail-compose via `.members` — the spread-in-place
keeps the upstream declaration intact.

**(b) Literal spread.** `Schema.Literals` accepts a spread the same way — same HEAD
placement, same rationale (literal order is equally irrelevant):

```ts
export const OrchestrationEventType = Schema.Literals([
  ...LOOM_EVENT_TYPES, // loom:
  /* …upstream literals unchanged… */
]);
```

**(c) Struct field spread.** Fork field additions to upstream structs become one
spread per struct. `Schema.withDecodingDefault` pipes travel inside the field record —
verified at runtime (defaults apply through the spread):

```ts
// orchestration.loom.ts
export const LoomThreadFields = {
  goalId: Schema.NullOr(GoalId),
  planLane: ThreadPlanLane.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_PLAN_LANE))),
  /* … */
} as const;

// orchestration.ts
export const OrchestrationThread = Schema.Struct({
  ...LoomThreadFields, // loom:
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  /* …upstream fields unchanged… */
});
```

Field position within a struct is irrelevant to decode (keys are disjoint, so spread
ordering cannot shadow), so the fork's currently *multiple* insertion blocks per
struct (e.g. `OrchestrationThread` has three) collapse into **one** spread per
struct. Place it as the **first entry inside the struct literal** (before `id`), for
the same merge reason as shape (a): upstream inserts/appends fields below, never
above the leading id fields, so the head position stays conflict-free.

**(d) Event member factory.** Fork event members need `EventBaseFields`, which is a
non-exported upstream const. To keep the one-way dependency, the loom file exports a
factory the upstream file calls with its own base fields:

```ts
// orchestration.loom.ts
export const makeLoomOrchestrationEventMembers = <const Base extends Schema.Struct.Fields>(base: Base) =>
  [
    Schema.Struct({ ...base, type: Schema.Literal("goal.created"), payload: GoalCreatedPayload }),
    /* …one per fork event… */
  ] as const;

// orchestration.ts — inside the OrchestrationEvent union literal:
  ...makeLoomOrchestrationEventMembers(EventBaseFields), // loom:
```

**(e) Type guards with a two-directional exactness check.** For Slice B, the loom
contracts file also exports the discriminator sets and narrowing guards (type-only
import of the full unions). The listed string array is verified against the member
tuples it must mirror — in **both directions**, so an omission AND a typo/extra entry
are each a compile error naming the offending literal:

```ts
// The literal guard array (the "listed" side).
export const LOOM_COMMAND_TYPES = [ /* 17 strings, §B.2 */ ] as const;
export type LoomCommandType = (typeof LOOM_COMMAND_TYPES)[number];

// The "expected" side, derived from the member tuples that are actually spliced
// (LoomClientCommandMembers + LoomInternalCommandMembers, shape a).
type LoomCommandMemberType = (typeof LoomClientCommandMembers)[number]["Type"]["type"]
  | (typeof LoomInternalCommandMembers)[number]["Type"]["type"];

// Exactness, both directions. `Exclude<Expected, Listed>` ≠ never ⇒ an entry is
// MISSING from the array; `Exclude<Listed, Expected>` ≠ never ⇒ a typo/extra entry.
type AssertNever<T extends never> = T;
type _MissingLoomCommandTypes = AssertNever<Exclude<LoomCommandMemberType, LoomCommandType>>;
type _ExtraLoomCommandTypes = AssertNever<Exclude<LoomCommandType, LoomCommandMemberType>>;

export type LoomOrchestrationCommand = Extract<OrchestrationCommand, { type: LoomCommandType }>;
const LOOM_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(LOOM_COMMAND_TYPES);
export const isLoomOrchestrationCommand = (
  command: OrchestrationCommand,
): command is LoomOrchestrationCommand => LOOM_COMMAND_TYPE_SET.has(command.type);
```

Same for `LOOM_EVENT_TYPES` / `LoomOrchestrationEvent` / `isLoomOrchestrationEvent`.
The event members come from the shape-(d) factory, so the expected side is derived
from an instantiation of the factory's return type:

```ts
type LoomEventMemberType = ReturnType<
  typeof makeLoomOrchestrationEventMembers<Record<never, never>>
>[number]["Type"]["type"];
```

Do **not** use `LOOM_COMMAND_TYPES satisfies ReadonlyArray<LoomOrchestrationCommand["type"]>`
— `LoomOrchestrationCommand` is defined *from* `LOOM_COMMAND_TYPES`, so the check is
circular (and even against the full union it would only catch typos, not omissions).
Do **not** derive the set from schema AST introspection
(`member.fields.type.ast.literal` types as `LiteralValue`, not the literal union —
tried and rejected in the spike).

**(f) After narrowing, TypeScript exhaustiveness survives.** `if (isLoomOrchestrationCommand(command)) return …;`
leaves `command` as `Exclude<OrchestrationCommand, LoomOrchestrationCommand>` in the
subsequent upstream switch, so the existing `default: command satisfies never` keeps
working — verified in the spike with a two-switch arrangement.

#### A.2.6 Spike provenance

Two throwaway spikes (`spike.loom.ts` / `spike.host.ts` / `spike.host.test.ts` and
`spike2.loom.ts` under `packages/contracts/src`, deleted before commit) proved under
`tsgo --noEmit` and `vp test`:

- union member spread (shape a) and tail-composition via `.members` both typecheck;
- literal spread into `Schema.Literals` (shape b) typechecks;
- struct-field spread with `withDecodingDefault` pipes (shape c) typechecks **and
  decodes correctly at runtime** (defaults applied when keys absent);
- event-member factory over generic base fields (shape d) typechecks and the
  resulting union narrows exhaustively;
- fork member decode through a spliced union works at runtime;
- guard + `Extract` narrowing preserves `satisfies never` exhaustiveness (shape e/f);
- AST-based literal extraction does **not** typecheck (hence the literal string array);
- the shape-(e) two-directional exactness check compiles clean when exact, and fails
  with `TS2344` naming the offending literal on BOTH an omitted entry and a
  typo/extra entry (including the factory-derived event variant);
- `git merge-file` merge simulations: head-position splice merges cleanly against an
  upstream tail append; tail-position splice conflicts (hence the head placement in
  shapes a–c).

### A.3 `orchestration.loom.ts` — what moves (complete inventory)

All of the following are fork-only declarations currently inside `orchestration.ts`
(verify each against `git diff 600972084 -- packages/contracts/src/orchestration.ts`);
move verbatim, comments included:

**Standalone schemas/consts:** `ThreadIsolation`, `DEFAULT_THREAD_ISOLATION`,
`ThreadFanInState`, `DEFAULT_THREAD_FAN_IN_STATE`, `ThreadPlanLane`,
`DEFAULT_THREAD_PLAN_LANE`, `AttentionReason`, `ThreadAttention`,
`DEFAULT_GATE_MAX_ROUNDS`, `MAX_GATE_MAX_ROUNDS`, `WorkstreamRoute`,
`WorkOutcomeDecision`, `WorkOutcomeCounts`, `WorkOutcomeRecord`, `LegacyThreadStatus`,
`QueuedMessages`, `OrchestrationGoalTask` (interface + encoded interface + codec),
`OrchestrationGoal`, `OrchestrationGoalShell`, `OrchestrationThreadConsultSummary`,
`ReasoningStreamItem`.

**Fork commands (non-exported structs; stay non-exported, join member tuples):**
`GoalCreateCommand`, `GoalMetaUpdateCommand`, `GoalArchiveCommand`,
`GoalUnarchiveCommand`, `GoalDeleteCommand`, `GoalTaskCreateCommand`,
`GoalTaskUpdateCommand`, `GoalTaskDeleteCommand`, `ThreadPlanLaneSetCommand`,
`ThreadAttentionRaiseCommand`, `ThreadAttentionClearCommand`,
`ThreadDependenciesSetCommand` → `LoomClientCommandMembers` (spliced into **both**
`DispatchableClientOrchestrationCommand` and `ClientOrchestrationCommand`).
`ThreadFanInSetCommand`, `ThreadMessageReasoningCompleteCommand`,
`ThreadConsultRecordCommand`, `ThreadWorkSubmitCommand`, `ThreadTurnStartFailCommand`
→ `LoomInternalCommandMembers` (spliced into `InternalOrchestrationCommand`).

**Fork event payloads (exported):** `GoalCreatedPayload`, `GoalMetaUpdatedPayload`,
`GoalArchivedPayload`, `GoalUnarchivedPayload`, `GoalDeletedPayload`,
`GoalTaskCreatedPayload`, `GoalTaskUpdatedPayload`, `GoalTaskDeletedPayload`,
`ThreadPlanLaneSetPayload`, `ThreadAttentionRaisedPayload`,
`ThreadAttentionClearedPayload`, `ThreadStatusSetPayload`,
`ThreadDependenciesSetPayload`, `ThreadMessageReasoningPayload`,
`ThreadTurnStartFailedPayload`, `ThreadReportSetPayload`,
`ThreadConsultRecordedPayload`, `ThreadOutcomeRecordedPayload`,
`ThreadRouteTakenPayload`, `ThreadFanInSetPayload` — plus the factory
`makeLoomOrchestrationEventMembers` (shape d) building the 20 event members.

**Field records (shape c), one spread each:**

| Record | Spread into | Fields |
|---|---|---|
| `LoomThreadFields` | `OrchestrationThread` | goalId, parentThreadId, role, purpose, brief, planLane, attention, blockedBy, spawnGeneration, reportPath, routes, gateRounds, pendingRework, lastOutcome, isolation, fanInState, cumulativeCostUsd, toolUses, usedTokens, maxTokens, diffAdditions, diffDeletions |
| `LoomThreadShellFields` | `OrchestrationThreadShell` | as above (shell carries the same set, incl. `brief`) plus lastActivityPreview, consults |
| `LoomSessionFields` | `OrchestrationSession` | lastErrorClass, queuedMessages |
| `LoomMessageFields` | `OrchestrationMessage` | reasoningText, reasoningStreaming |
| `LoomReadModelFields` | `OrchestrationReadModel` | goals |
| `LoomShellSnapshotFields` | `OrchestrationShellSnapshot` | goals |
| `LoomThreadCreateCommandFields` | `ThreadCreateCommand` | goalId, parentThreadId, role, purpose, brief, blockedBy, routes, isolation, planLane, spawnGeneration |
| `LoomThreadMetaUpdateFields` | `ThreadMetaUpdateCommand` | goalId, role, purpose |
| `LoomTurnStartFields` | `ThreadTurnStartCommand` | requireIdle, setInProgress, reopen |
| `LoomBootstrapCreateThreadFields` | `ThreadTurnStartBootstrapCreateThread` | goalId, parentThreadId, role, purpose, brief |
| `LoomThreadCreatedPayloadFields` | `ThreadCreatedPayload` | goalId, parentThreadId, role, purpose, brief, planLane, attention, blockedBy, routes, isolation, spawnGeneration |
| `LoomThreadMetaUpdatedPayloadFields` | `ThreadMetaUpdatedPayload` | goalId, role, purpose |

`LoomThreadFields` and `LoomThreadShellFields` share most fields — the coder may
factor the common subset into one record spread into both (judgement call; do not
contort if the shell variants differ subtly, e.g. `gateRounds` doc comments).

**Union member spreads (shape a):**

| Tuple | Spliced into |
|---|---|
| `LoomClientCommandMembers` | `DispatchableClientOrchestrationCommand`, `ClientOrchestrationCommand` |
| `LoomInternalCommandMembers` | `InternalOrchestrationCommand` |
| `makeLoomOrchestrationEventMembers(EventBaseFields)` | `OrchestrationEvent` |
| `LoomShellStreamEventMembers` (goal-upserted, goal-removed) | `OrchestrationShellStreamEvent` |
| `LoomThreadStreamItemMembers` (reasoning-delta) | `OrchestrationThreadStreamItem` |

**Literal spreads (shape b):** `LOOM_EVENT_TYPES` → `OrchestrationEventType`.

**Guards (shape e):** `LOOM_COMMAND_TYPES` / `isLoomOrchestrationCommand` /
`LoomOrchestrationCommand`; `LOOM_EVENT_TYPES` / `isLoomOrchestrationEvent` /
`LoomOrchestrationEvent`. (Exported for Slice B.)

**Residuals that stay in `orchestration.ts` (marked `// loom:`):**

- `OrchestrationAggregateKind = Schema.Literals(["project", "goal", "thread"])` — the
  `"goal"` literal (one word). Optionally splice via `...LOOM_AGGREGATE_KINDS`;
  either way, one marked line.
- `aggregateId: Schema.Union([ProjectId, GoalId, ThreadId])` in `EventBaseFields` —
  the `GoalId` member (one word).
- The import lines for loom identifiers (`GoalId`, `GoalTaskId`, `NonNegativeNumber`
  from baseSchemas; `RuntimeErrorClass` from providerRuntime; the loom-file import).
- The 19 splice lines themselves.

### A.4 `settings.loom.ts` — what moves

**Moves:** `ReasoningDisplayMode` + `DEFAULT_REASONING_DISPLAY_MODE`,
`ProviderFailoverSettings`, and five field records:

| Record | Spread into |
|---|---|
| `LoomClientSettingsFields` | `ClientSettingsSchema` (reasoningDisplay) |
| `LoomClientSettingsPatchFields` | `ClientSettingsPatch` (reasoningDisplay as `optionalKey`) |
| `LoomModelPreferenceFields` | the nested struct inside `providerModelPreferences` (selectedModels, showOnlySelectedModels) — **both** in `ClientSettingsSchema` and in `ClientSettingsPatch` |
| `LoomServerSettingsFields` | `ServerSettings` (workstreamModelPresets, providerFailover) |
| `LoomServerSettingsPatchFields` | `ServerSettingsPatch` (workstreamModelPresets, providerFailover patch struct) |

`settings.loom.ts` imports `ModelSelection` from `./orchestration.ts` — that is fine
(no cycle; settings.ts already does).

**Stays in `settings.ts` as residuals (marked `// loom:`):**

- `PiSettings` + `PiSettingsPatch` + the `pi:` provider lines in `ServerSettings`/
  `ServerSettingsPatch`. Reason: `PiSettings` is built with `makeBinaryPathSetting`,
  a **non-exported upstream const** — importing it from a loom file creates a
  value-level init cycle (settings.ts imports the loom file at top, so the loom
  module body would run before `makeBinaryPathSetting` is initialised → TDZ crash).
  It also matches upstream's own per-provider block pattern (Codex/Claude/Grok), so
  it merges the way upstream's own provider additions do. Do not move it.
- The default git-text-generation model substitution (`PI_DEFAULT_MODEL` /
  `instanceId: "pi"`) — product behaviour substitution, 2 lines.

### A.5 Acceptance (Slice A)

1. `vp check` and `vp run typecheck` green (workspace-wide — server and web consume
   these types).
2. `packages/contracts` tests pass unchanged, including `orchestration.test.ts` and
   `settings.test.ts` (their imports from `./orchestration.ts` / `./settings.ts` must
   keep resolving — if any imported identifier moved, update the test's import to the
   loom file or the package root; that is the *only* permitted test edit).
3. Grep check: no remaining definition of a moved identifier in the upstream files;
   no value-import of `orchestration.ts` from `orchestration.loom.ts`.
4. `git diff 600972084 -- packages/contracts/src/orchestration.ts` shows only:
   import lines, splice lines, and the §A.3 residuals — every hunk `// loom:`-marked.
5. Cross-package consumers compile untouched: `rpc.ts:639`
   (`payload: ClientOrchestrationCommand`), `ipc.ts`, `provider.ts`,
   `environmentHttp.ts`, and `apps/server/src/persistence/Layers/OrchestrationEventStore.ts:32`
   (`Schema.decodeUnknownEffect(OrchestrationEvent)`) — all composition-indifferent,
   none may need edits. If one does, stop and re-check the splice.

---

## Slice B — decider/projector delegation

**Depends on Slice A** (uses `isLoomOrchestrationCommand`, `LoomOrchestrationCommand`,
`isLoomOrchestrationEvent`, `LoomOrchestrationEvent` from `orchestration.loom.ts`).

### B.1 Outcome

- `apps/server/src/orchestration/decider.ts`: from +1324/−11 to roughly **the ~8
  modified upstream cases (§B.4) + one delegation guard + 2 `export` keyword
  additions + trimmed imports**. ~900+ added lines relocate.
- `apps/server/src/orchestration/projector.ts`: from +529/−1 to **fork fields inside
  upstream cases (§B.4) + one delegation guard + a few `export` keywords**. ~430
  lines relocate.
- `apps/server/src/orchestration/commandInvariants.ts`: from +216 to **byte-identical
  with the baseline** (all fork additions are additive helper functions).

New fork-owned files: `decider.loom.ts`, `projector.loom.ts`,
`commandInvariants.loom.ts` (same directory).

### B.2 Decider: cases that move to `decider.loom.ts` (17)

`goal.create`, `goal.meta.update`, `goal.archive`, `goal.unarchive`, `goal.delete`,
`goal.task.create`, `goal.task.update`, `goal.task.delete`, `thread.plan-lane.set`,
`thread.attention.raise`, `thread.attention.clear`, `thread.dependencies.set`,
`thread.message.reasoning.complete`, `thread.work.submit`, `thread.consult.record`,
`thread.fanin.set`, `thread.turn-start.fail`.

This list **is** `LOOM_COMMAND_TYPES` (Slice A shape e) — keep them in lockstep; the
two-directional exactness check on the guard array (shape e: missing AND extra
entries are compile errors) plus the loom switch's own `satisfies never` default
make drift a compile error in either direction.

**Shape of `decider.loom.ts`:**

```ts
export const decideLoomCommand = Effect.fn("decideLoomCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: LoomOrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult, // re-derive locally: PlannedOrchestrationEvent | ReadonlyArray<…>
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "goal.create": { /* moved verbatim */ }
    /* … */
    default: {
      command satisfies never;
      /* same unknown-command error as upstream's default */
    }
  }
});
```

**Delegation point in `decider.ts`** — one guard at the top of
`decideOrchestrationCommand`, before the switch:

```ts
  if (isLoomOrchestrationCommand(command)) {
    return yield* decideLoomCommand({ command, readModel }); // loom:
  }
  switch (command.type) { /* upstream switch, fork-only cases removed */
```

After the guard, `command` narrows to `Exclude<OrchestrationCommand,
LoomOrchestrationCommand>`, so the upstream switch's `default: command satisfies never`
still compiles (proven in the Slice A spike).

**Shared helpers — the import cycle, handled deliberately:**

- `withEventBase`, `decideCommandSequence`, and the `PlannedOrchestrationEvent` type
  are **upstream code and stay in `decider.ts`** (moving them would be upstream
  refactoring). Add the `export` keyword to `withEventBase` and
  `decideCommandSequence` (and `export type` the two type aliases) — marked `// loom:`.
- `decider.loom.ts` imports them from `decider.ts`; `decider.ts` imports
  `decideLoomCommand` (and `dependencyCoherenceError`, below) from `decider.loom.ts`.
  This is a **module cycle, and it is safe here**: both files only reference the
  other's bindings inside function bodies (call time), never during module init.
  Document this with a short comment at the loom file's import. If the coder prefers
  to avoid the cycle, the alternative is passing `decideCommandSequence` as a
  parameter into `decideLoomCommand` — allowed, but the cycle is the recommended
  simpler mechanic. The cycle is required because `goal.archive`/`goal.unarchive`/
  `goal.delete` cascade through `decideCommandSequence` into upstream `thread.*`
  commands, and upstream `project.delete` cascades into `goal.delete`.
- `nowIso` is one line — re-declare locally in `decider.loom.ts`, do not export it.
- `dependencyCoherenceError` is **fork code** used by both the moved
  `thread.dependencies.set` case and the retained fork additions inside upstream's
  `thread.create` — it moves to `decider.loom.ts` and is exported; `decider.ts`
  imports it (no new edge — the delegation import already exists).
- The `@t3tools/shared` imports (`routeWorkSubmit`, `findDependencyCycle`,
  `describeUnsatisfiedDependency`) and `flattenGoalTasks` move with their cases;
  `decider.ts` keeps `findDependencyCycle` etc. only if the retained `thread.create`
  fork block still needs them (it calls `dependencyCoherenceError`, which owns them —
  so it should not).

### B.3 `commandInvariants.loom.ts`

Move every fork-added helper out of `commandInvariants.ts`: `findGoalById`,
`listGoalsByProjectId`, `requireActiveGoalInProject`, `requireGoal`,
`requireGoalAbsent`, `requireGoalActive`, `requireGoalNotDeleted`,
`requireGoalParentTask`, `requireGoalTask`, `requireGoalTaskAbsent`,
`requireUniqueGoalSlug`, `requireActiveWorkspaceRootAvailable` (confirm the full set
with `git diff 600972084 -- apps/server/src/orchestration/commandInvariants.ts` —
everything fork-added is an additive function or type import). Goal: the upstream
file returns **byte-identical to the baseline**. Update imports in `decider.ts`
(retained cases use `findGoalById`, `listGoalsByProjectId`,
`requireActiveGoalInProject`, `requireActiveWorkspaceRootAvailable`) and
`decider.loom.ts`.

### B.4 Decider: modified upstream cases that STAY — explicitly out of scope

Do **not** attempt to extract these; they change what upstream commands mean and are
behavioural entanglement, not placement. Add `// loom:` markers where missing:

1. `project.create` — workspace-root-availability invariant call.
2. `project.delete` — active-goals check + goal.delete cascade commands.
3. `thread.create` — goal validation, dependency-coherence backstop, fork payload
   fields.
4. `thread.archive` — cascade UP to `goal.archived`.
5. `thread.unarchive` — cascade UP to `goal.unarchived`.
6. `thread.meta.update` — goal validation, worktree-binding-clear warning, goal
   rename cascade, fork payload fields.
7. `thread.turn.start` — reopen guards, sticky-terminal, attention-clear-all,
   `setInProgress` atomic kickoff, reopen-observability activity (~130 lines).
8. `thread.turn.interrupt` — `needs_guidance` raise on human stop.

### B.5 Projector: cases that move to `projector.loom.ts` (18 cases; 20 event types)

`goal.created`, `goal.meta-updated`, `goal.archived`, `goal.unarchived`,
`goal.deleted`, `goal.task-created`, `goal.task-updated`, `goal.task-deleted`,
`thread.plan-lane-set`, `thread.attention-raised`, `thread.attention-cleared`,
`thread.status-set`, `thread.dependencies-set`, `thread.report-set`,
`thread.outcome-recorded`, `thread.route-taken`, `thread.fanin-set`,
`thread.message-reasoning` — plus `thread.turn-start-failed` and
`thread.consult-recorded`, which have **no** in-memory projection case (today
upstream's `default` returns the model unchanged; the loom projector's own
`default: return Effect.succeed(nextBase)` covers them identically). All 20 are
members of `LOOM_EVENT_TYPES`.

**Shape:** `projectLoomEvent(nextBase, event: LoomOrchestrationEvent)` with the same
`Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError>` signature.
Delegation in `projectEvent` immediately after `nextBase` is built:

```ts
  if (isLoomOrchestrationEvent(event)) {
    return projectLoomEvent(nextBase, event); // loom:
  }
  switch (event.type) { /* upstream switch, fork cases removed */
```

**Shared helpers:** `decodeForEvent`, `updateThread`, `MAX_THREAD_MESSAGES` are
upstream — add `export` keywords (marked). The `ThreadPatch` type — `export type` it.
`remapLegacyStatus` and `updateGoalTasks` are **fork code** — they move to
`projector.loom.ts`; update the one external import
(`Layers/ProjectionPipeline.ts:15` imports `remapLegacyStatus` — a fork-heavy file;
change the import path, nothing else).

**Modified upstream projector cases that STAY (residuals):**

1. `thread.created` — populates the fork fields (goalId, planLane, attention,
   blockedBy, routes, isolation, fanInState, spawnGeneration, reportPath defaults).
2. `thread.meta-updated` — goalId/role/purpose patch lines.
3. `createEmptyReadModel` — `goals: []` line.

### B.6 Acceptance (Slice B)

1. `vp check` and `vp run typecheck` green.
2. **Every existing test passes unchanged** — no test-file edits at all in this
   slice: `decider.attentionTerminal`, `decider.cancelCascade`, `decider.delete`,
   `decider.dependencies`, `decider.errorGuard`, `decider.isolation`,
   `decider.projectScripts`, `decider.projectWorkspaceRoot`, `decider.reviewGate`,
   `decider.workSubmit`, `projector.test.ts`, `commandInvariants.test.ts` all import
   `decideOrchestrationCommand` / `projectEvent` / invariant helpers through
   interfaces this slice preserves. `commandInvariants.test.ts` — check whether it
   tests fork helpers; if so, its imports may move to `commandInvariants.loom.ts`
   (the single permitted test edit, import-path only).
3. `git diff 600972084 -- apps/server/src/orchestration/commandInvariants.ts` is
   empty. The decider/projector diffs match §B.4/§B.5 residuals + guard + exports.
4. No top-level (module-init-time) cross-calls between `decider.ts` and
   `decider.loom.ts` — imports referenced from function bodies only.

---

## Slice C — server composition seam

Independent of A/B. May run in parallel with Slice A.

### C.1 Outcome

Fork layer/startup/ws insertions in three upstream files collapse behind a fork-owned
module directory `apps/server/src/loom/`:

- `loom/serverLayers.ts` — exported layer bundles consumed by `server.ts`
- `loom/startup.ts` — sweep-start effect + startup reconcile, consumed by
  `serverRuntimeStartup.ts`
- `loom/wsMethods.ts` — fork WS handler record + scope entries, consumed by `ws.ts`

Honest expectations: `server.ts` goes from ~20 fork import lines + ~12 scattered
`provideMerge` insertions to **~2 import lines + ~6 one-line splices + 2 marked
substitutions**. `serverRuntimeStartup.ts` from +119 to ~25 residual lines. `ws.ts` is
the smallest win — the fork's entangled rewrites there (§C.5) stay; only the method
registrations narrow.

### C.2 Inventory: current fork insertions

**server.ts** (all vs `600972084`):

| Site | Fork content |
|---|---|
| `ReactorLayerLive` | `WorkstreamWorktreeStatus.layer` (first), `WorkstreamDispatcherLive`, `WorkstreamFanInReactorLive`, `WorktreeReaperLive` (after ThreadDeletionReactorLive), `ReasoningStreamBusLive` (last) |
| `PersistenceLayerLive` | `SqliteReadLayerLive` added |
| `ProviderRuntimeLayerLive` | reshaped to `Layer.mergeAll(ProviderSessionReaperLive, WorkstreamLivenessSweepLive, ExhaustionResumeSweepLive, SubscriptionUsagePollerLive)`; `OrchestrationLayerLive` → `OrchestrationLayerOnSqlReadClient` |
| `RuntimeCoreDependenciesLive` | `UsageBreakdownQueryOnSqlReadClient` + `WorktreeProvisionerLive` in the first mergeAll; `WorktreeMutationLockLive` merged with SourceControlProviderRegistry; `ProviderHealthRegistryLive.pipe(provideMerge(AccountUsageRegistryLive))` merged with ProviderEventLoggers |
| `makeRoutesLayer` | `WorkstreamSpawnHttp.layer`, `GoalTaskHttp.layer`, `GoalHandoffHttp.layer` merged with `McpHttpServer.layer` |
| `makeServerLayer` | `yield* provisionCliToken();` |

**serverRuntimeStartup.ts:** 4 fork service imports + acquisitions
(`WorkstreamLivenessSweep`, `ExhaustionResumeSweep`, `SubscriptionUsagePoller`,
`ProviderService`); 3 `.start()` calls in the reactor scope;
`reconcileStartupStaleSessionState` (~70 lines) + its `runStartupPhase` invocation;
PI default-model substitution; auto-bootstrap project re-resolve block; `Cause.pretty`
logging tweaks.

**ws.ts:** ~12 fork imports; 6 service acquisitions; 3 `RPC_REQUIRED_SCOPE` entries;
4 fork handlers (`heartbeat`, `serverGetUsageBreakdown`,
`serverGetWorkstreamWorktrees`, `serverRemoveWorkstreamWorktree`); plus entangled
rewrites listed in §C.5.

### C.3 `loom/serverLayers.ts` — exported bundles

```ts
// Consumed by ReactorLayerLive with ONE provideMerge, positioned after
// ThreadDeletionReactorLive. ReasoningStreamBusLive is provideMerge'd inside the
// bundle so it feeds the fork reactors AND is exported to the earlier upstream
// layers (ProviderRuntimeIngestion consumes it) via the outer provideMerge.
export const LoomReactorsLive = Layer.mergeAll(
  WorkstreamWorktreeStatus.layer,
  WorkstreamDispatcherLive,
  WorkstreamFanInReactorLive,
  WorktreeReaperLive,
).pipe(Layer.provideMerge(ReasoningStreamBusLive));

export const LoomPersistenceLive = SqliteReadLayerLive;

// Merged alongside ProviderSessionReaperLive in ProviderRuntimeLayerLive.
export const LoomProviderRuntimeLive = Layer.mergeAll(
  WorkstreamLivenessSweepLive, ExhaustionResumeSweepLive, SubscriptionUsagePollerLive,
);

// Joins the CheckpointingLayerLive mergeAll.
export const LoomRuntimeCoreLive = Layer.mergeAll(
  UsageBreakdownQueryOnSqlReadClient, WorktreeProvisionerLive,
);

// Joins the SourceControlProviderRegistry mergeAll (lock feeds provisioner + fan-in).
export const LoomWorktreeMutationLockLive = WorktreeMutationLockLive;

// Joins the ProviderEventLoggers mergeAll.
export const LoomProviderHealthLive =
  ProviderHealthRegistryLive.pipe(Layer.provideMerge(AccountUsageRegistryLive));

// Merged with McpHttpServer.layer before the McpSessionRegistry provide.
export const LoomMcpHttpLive = Layer.mergeAll(
  WorkstreamSpawnHttp.layer, GoalTaskHttp.layer, GoalHandoffHttp.layer,
);
```

`server.ts` then carries: one import line from `./loom/serverLayers.ts`, six one-line
splices (each `// loom:`-marked), and **two marked substitutions that stay**:
`OrchestrationLayerLive → OrchestrationLayerOnSqlReadClient` (a replacement, not an
addition — cannot be additive-spliced) and the `provisionCliToken()` call. The
positioning comments currently in `server.ts` (e.g. the pipe-argument-ceiling notes)
move into `loom/serverLayers.ts` where they describe fork bundles; positioning
comments about the splice sites stay with the splice lines.

**Verify by construction, not assumption:** `Layer.provideMerge` ordering is
load-bearing. The coder must confirm the six splice points reproduce today's
dependency satisfaction exactly — the acceptance is `vp check` (which boots layer
composition in tests) plus a manual `vp run typecheck`. If a bundle cannot satisfy
ordering from a single splice point (e.g. the mutation lock), keep it as its own
one-line splice rather than force-merging bundles.

### C.4 `loom/startup.ts`

- `startLoomSweeps`: one exported effect acquiring and starting
  `WorkstreamLivenessSweep`, `ExhaustionResumeSweep`, `SubscriptionUsagePoller` —
  call site in `serverRuntimeStartup.ts` becomes one line inside the existing
  reactor-scope gen (`yield* startLoomSweeps.pipe(Scope.provide(reactorScope))` —
  match the existing scope-provision pattern exactly).
- `reconcileStartupStaleSessionState` + `hasActiveProviderTurn` +
  `startupReconcileCommandId` move here verbatim, plus an exported
  `reconcileStaleSessionsGuarded` wrapping the existing `catchCause` logging, so the
  call site is `yield* runStartupPhase("sessions.reconcile", reconcileStaleSessionsGuarded)`
  (+ the debug log line).
- **Test import moves:** `Layers/WorkstreamDispatcher.test.ts:496,522` imports
  `reconcileStartupStaleSessionState` from `../serverRuntimeStartup.ts` → update to
  `../../loom/startup.ts`. This is the only permitted test edit in Slice C.

**Residuals in `serverRuntimeStartup.ts` (marked):** PI default model substitution
(`getAutoBootstrapDefaultModelSelection`), the auto-bootstrap project re-resolve
block, `Cause.pretty` log-format tweaks, the two startup-phase call lines, the
`startLoomSweeps` line, imports.

### C.5 `loom/wsMethods.ts`

Export two things:

```ts
export const LOOM_RPC_SCOPES = [
  [WS_METHODS.serverGetUsageBreakdown, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetWorkstreamWorktrees, AuthOrchestrationReadScope],
  [WS_METHODS.serverRemoveWorkstreamWorktree, AuthOrchestrationOperateScope],
] as const;

export const makeLoomWsHandlers = (deps: {
  readonly observeRpcEffect: /* the local wrapper's type */;
  readonly usageBreakdownQuery: UsageBreakdownQuery.Shape;
  readonly workstreamWorktreeStatus: WorkstreamWorktreeStatus.Shape;
}) => ({
  [WS_METHODS.heartbeat]: (_input) => Effect.void, // incl. the bypass-rationale comment
  [WS_METHODS.serverGetUsageBreakdown]: /* moved verbatim */,
  [WS_METHODS.serverGetWorkstreamWorktrees]: /* moved verbatim */,
  [WS_METHODS.serverRemoveWorkstreamWorktree]: /* moved verbatim */,
});
```

`ws.ts` splices: `...LOOM_RPC_SCOPES` inside the `RPC_REQUIRED_SCOPE` map-constructor
array (1 line), `...makeLoomWsHandlers({ … })` inside `WsRpcGroup.of({ … })` (1 line),
and keeps the service acquisitions the handlers need (they may move into the handler
factory if the coder passes the services in — preferred). The heartbeat scope-bypass
note stays coherent: `RPC_REQUIRED_SCOPE.get` simply has no heartbeat entry, unchanged.

**Explicitly staying in `ws.ts` (entangled rewrites — do not touch):**

- the `subscribeThread` connect-gap/reasoning-bus rewrite,
- the `providerStatuses` exhaustion-overlay fold and `accountUsage` streams in the
  config subscription,
- the goal-aggregate branch in the shell-stream event mapper,
- the `isThreadDetailEvent` union additions,
- the worktree-provisioner bootstrap substitution (fork *replaced* upstream's
  setup-script plumbing — a substitution, not an addition),
- remaining fork service acquisitions those rewrites use
  (`reasoningStreamBus`, `accountUsageRegistry`, `providerHealthRegistry`,
  `worktreeProvisioner`).

Mark each with `// loom:` where not already obvious.

### C.6 Acceptance (Slice C)

1. `vp check` and `vp run typecheck` green.
2. Server boots: the layer graph resolves (covered by existing layer-composition
   tests under `vp check`; if a targeted smoke exists, run it).
3. `WorkstreamDispatcher.test.ts` passes with only its import path changed.
4. `git diff 600972084 -- apps/server/src/server.ts` shows only imports + six
   marked splices + two marked substitutions; `serverRuntimeStartup.ts` and `ws.ts`
   diffs match the residual inventories above.

---

## Sequencing

```
Slice A (contracts) ──► Slice B (decider/projector)
Slice C (server wiring) — parallel with A (no shared files, no type dependencies)
```

Confirmed as briefed: B needs A's guards/types; C touches disjoint files and imports
nothing A moves (server layers reference fork layer files, not contract internals).
If run as three coders: A and C start immediately; B starts when A lands. Merge order
A → C → B or A → B → C both work; avoid concurrent edits to
`apps/server/src/orchestration/` (B owns it exclusively).

## Test strategy (campaign-wide)

- The **decider/projector suites are the behavioural lock**: they test through
  `decideOrchestrationCommand` / `projectEvent`, which keep their signatures. They
  must pass with zero edits (Slice B acceptance).
- Contracts tests (`orchestration.test.ts`, `settings.test.ts`) lock decode
  behaviour, including `withDecodingDefault` travel through spreads.
- Only two test files may be touched, both import-path-only:
  `WorkstreamDispatcher.test.ts` (Slice C) and possibly
  `commandInvariants.test.ts` (Slice B).
- Final check after all slices: `vp check && vp run typecheck` at the repo root, then
  re-run `git diff 600972084 --stat` on the six target files and compare against the
  expected residual footprints in this document.

## Risks

| Risk | Mitigation |
|---|---|
| Module-init cycle contracts-side (loom file importing `orchestration.ts`/`settings.ts` values) | Hard rule in §A.2; factory pattern for `EventBaseFields`; `PiSettings` deliberately not moved. Type-only imports allowed. |
| Decider↔loom import cycle misuse | Safe only while cross-references stay inside function bodies; documented at the import site; reviewer checks for top-level calls. |
| `Layer.provideMerge` ordering breakage in server.ts | Bundles designed around today's ordering (§C.3); `vp check` boots the graph; fall back to per-layer splice lines if a bundle can't satisfy ordering. |
| Union member reordering changing decode | Discriminated by disjoint `type` literals — order-irrelevant; locked by contracts + decider suites. |
| A consumer introspecting union `.members`/literal order | Grepped: none exist (`.members` unused outside contracts; `OrchestrationEventType.literals` unused). If one appears mid-campaign, stop and reassess. |
| Upstream merge conflicts moving rather than shrinking | Every remaining fork touch is `// loom:`-marked, so residual conflicts are self-identifying; splice lines sit at literal heads (§A.2a), merge-tested clean against upstream tail appends — only a rare upstream head insertion still conflicts. |
| A fork command/event missing from the guard set silently skipping delegation | Two-directional exactness check (§A.2e): `Exclude<Expected, Listed>` and `Exclude<Listed, Expected>` both asserted `never`, so omission and typo each fail compile naming the literal. |
| Encoded JSON key order changes from collapsed struct spreads | JSON object key order is not part of any contract here (decode is key-based); snapshot/event stores decode structurally. |

## What NOT to do (recap)

- No behavioural changes; no upstream-logic refactors; no renamed exports.
- Do not touch `ProjectionSnapshotQuery.ts` or `ProviderRuntimeIngestion.ts`.
- Do not extract the §B.4 modified upstream decider cases or §C.5 entangled ws.ts
  rewrites.
- Do not move `PiSettings` out of `settings.ts`.
- Do not derive discriminator sets from schema AST introspection.
