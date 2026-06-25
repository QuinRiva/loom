---
manager_sessions:
  - id: 55d64863-fe10-4049-b93e-0bf415b2410c
    name: workstream-graph-state-rollup-design
    role: architecture
    authored_at: 2026-06-24T10:10:47.921Z
---

# Workstream Graph-State Rollup

**Status:** design (paper only — no product code changes in this doc)
**Author:** researcher sub-thread (T3 Code Workstream), 2026-06-24
**Scope:** how to collapse an orchestrator's whole sub-thread DAG into a single
_graph state_ + a live _active-worker count_ for display on the orchestrator's
row in the web sidebar.

---

## 1. Problem & the one nuance that drives everything

The sidebar shows one row per top-level thread. When a thread is an orchestrator
that has spawned a DAG of sub-threads (children, grandchildren, …), that single
row must answer two questions at a glance:

1. **What is the state of the graph _as a whole_?** Not any single worker — the
   whole subtree.
2. **How many workers are live right now?** The "1 vs 37" signal Carl wants
   visible without drilling into the Workstream panel.

The load-bearing nuance: **liveness anywhere in the DAG dominates local
blocked-ness.** A node that is `blocked`/waiting because its dependency is
_currently running_ does **not** make the graph blocked — the graph is actively
making progress and will unstick itself. The graph is only genuinely
"blocked / needs you" when **nothing is running anywhere** and either something
is waiting on a human, or the remaining work is structurally stuck (a cycle).

Every decision below falls out of putting that liveness check _first_.

---

## 2. Inputs (what we already have)

Each node is a `SidebarThreadSummary` (`apps/web/src/types.ts`):

| field                       | values                                                              | meaning                                       |
| --------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| `status`                    | `planned \| running \| blocked \| review \| done`                   | explicit workflow status (human/agent intent) |
| `blockedBy`                 | `ThreadId[]`                                                        | waits-on edges                                |
| `session.status`            | `disconnected \| connecting \| ready \| running \| error \| closed` | live session phase                            |
| `latestTurn.state`          | `running \| interrupted \| completed \| error`                      | live turn phase                               |
| `hasPendingApprovals`       | bool                                                                | mid-turn human gate (approve a tool call)     |
| `hasPendingUserInput`       | bool                                                                | mid-turn human gate (answer a prompt)         |
| `hasActionableProposedPlan` | bool                                                                | a proposed plan is ready for you              |
| `parentThreadId`            | `ThreadId \| null`                                                  | lineage edge                                  |
| `archivedAt`                | iso \| null                                                         | archived nodes are excluded from the rollup   |

Existing logic this design stays consistent with:

- **`resolveBaseColumn`** (`WorkstreamPanel.tsx`) — a node's column ignoring
  dependencies: `review`/`done` win; explicit `blocked` ⇒ blocked;
  `status==="running"` or a live session/turn (`hasRunningSignal`) ⇒ running;
  else planned. We reuse this exactly.
- **`getEffectiveColumn`** — `resolveBaseColumn` plus the "unmet `blockedBy` dep
  ⇒ blocked" step (the **D1 precedence**). We deliberately **do not** roll this
  up node-by-node, because it collapses blocked-on-running into `blocked` and
  would hide liveness. See §4.
- **`areDependenciesSatisfied`** (`workstreamDependencies.ts`) — the single
  source of truth for "may this node run": a `blockedBy` entry gates **only**
  when it names a **known sibling** (same `parentThreadId`) that is not yet
  `done`. `review` does not release. Self-refs, dangling ids, and non-siblings
  never gate. Our deadlock analysis uses **this** predicate, not
  `getEffectiveColumn`'s looser inline version (which omits the sibling check
  because the board only ever feeds it one level of siblings).
- **`THREAD_STATUS_PRIORITY` / `resolveProjectStatusIndicator`**
  (`Sidebar.logic.ts`) — the precedent for "roll several child statuses up to
  one parent row by taking the highest-priority one." We mirror its shape for
  the human-attention reason ladder and the parent-row composition.

---

## 3. The graph states (minimal set)

Six top-level states. Five are real graph states; `empty` is a sentinel that
means "no DAG — show the thread's own pill unchanged."

| state            | one-line definition                                                                                                                        | what the user should do                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **`active`**     | ≥1 worker is live somewhere in the DAG (running turn/session, or spinning up).                                                             | Nothing — watch it go.                                                                    |
| **`attention`**  | Nothing live, **and** something needs a human: approval, input, an actionable plan, a `review` sign-off, or a manually-declared `blocked`. | Go act — the graph is stalled on you. `highestAttentionReason` says which kind.           |
| **`deadlocked`** | Nothing live, no human gate, but incomplete work that **cannot self-progress** — a `blockedBy` cycle (or work that only waits on a cycle). | Fix the DAG; it will never unstick itself. **Footgun — surfaced as a first-class state.** |
| **`idle`**       | Nothing live, no human gate, not deadlocked, but incomplete: ≥1 planned node is _runnable_ (deps satisfied) yet not dispatched.            | Usually transient (about to dispatch) or a manual thread awaiting its first turn.         |
| **`done`**       | Non-empty DAG, every (non-archived) node settled to `done`.                                                                                | Archive / move on.                                                                        |
| **`empty`**      | No (non-archived) descendants.                                                                                                             | N/A — the row shows the thread's own pill.                                                |

Why these and not fewer:

- **`active` vs `attention`** is the whole point (§1). They must be distinct and
  liveness must be checked first.
- **`deadlocked` vs `idle`** — both are "nothing running, no human gate,
  incomplete," but the remediation differs completely: `idle` resolves itself
  (or with one user turn); `deadlocked` _never_ resolves without rewiring the
  graph. Collapsing them would bury the footgun. Carl asked for deadlock to be a
  real state.
- **`review` is folded into `attention`**, not given its own top-level state, to
  keep the set minimal. The distinction (review sign-off vs approval vs input)
  is preserved in `highestAttentionReason`, which the UI can render as a chip.
  This matches the deliverable's request for a separate `highestAttentionReason`
  rather than multiplying top-level states.

### Output contract

```ts
type GraphState = "active" | "attention" | "deadlocked" | "idle" | "done" | "empty";
type AttentionReason = "approval" | "input" | "review" | "blocked" | "plan";

interface GraphRollup {
  graphState: GraphState;
  activeWorkerCount: number; // see §5
  highestAttentionReason: AttentionReason | null;
}
```

`highestAttentionReason` is computed **independently of `graphState`** (it is set
even while `active`), so the UI can show e.g. "5 working · 1 needs approval."

---

## 4. The decision algorithm

A **single global scan**, not a per-node column rollup. The ordering _is_ the
precedence ladder; liveness-first is what encodes "liveness dominates local
blocked-ness."

```ts
const ATTENTION_PRIORITY: Record<AttentionReason, number> = {
  approval: 5,
  input: 4,
  review: 3,
  blocked: 2,
  plan: 1,
};

// A genuinely-executing worker. Used for the headline count AND the state gate.
const isActiveWorker = (t: SidebarThreadSummary): boolean =>
  t.session?.status === "running" || t.latestTurn?.state === "running";

// Liveness for the STATE gate is slightly broader than the count: a session
// that is `connecting` is a worker spinning up. Counting it as live prevents the
// row from flashing "idle/deadlocked/needs-you" during a reconnect or restart.
const isLive = (t: SidebarThreadSummary): boolean =>
  isActiveWorker(t) || t.session?.status === "connecting";

// A node that needs a human before the graph can advance. Order matters only for
// `highestAttentionReason`; presence (≠ null) is what gates `attention`.
// NOTE: this is only consulted AFTER the liveness check, so an explicit `blocked`
// node whose blocker is currently running never reaches here — it is `active`.
const attentionReasonOf = (t: SidebarThreadSummary): AttentionReason | null =>
  t.hasPendingApprovals
    ? "approval"
    : t.hasPendingUserInput
      ? "input"
      : t.status === "review"
        ? "review"
        : t.status === "blocked"
          ? "blocked" // manual/agent-declared, not dep-derived
          : t.hasActionableProposedPlan
            ? "plan"
            : null;

function rollupGraphState(
  descendants: ReadonlyArray<SidebarThreadSummary>, // full descendant set (§6)
  byId: ReadonlyMap<ThreadId, SidebarThreadSummary>, // same set, indexed
): GraphRollup {
  const nodes = descendants.filter((t) => t.archivedAt == null);

  if (nodes.length === 0)
    return { graphState: "empty", activeWorkerCount: 0, highestAttentionReason: null };

  const activeWorkerCount = nodes.filter(isActiveWorker).length;

  const highestAttentionReason =
    nodes
      .map(attentionReasonOf)
      .filter((r): r is AttentionReason => r !== null)
      .sort((a, b) => ATTENTION_PRIORITY[b] - ATTENTION_PRIORITY[a])[0] ?? null;

  // 1. Liveness dominates. THIS is the blocked-on-running rule: if the blocker is
  //    running, the running node is counted here and we return before ever
  //    looking at the blocked node's local column.
  if (nodes.some(isLive))
    return { graphState: "active", activeWorkerCount, highestAttentionReason };

  // 2. Nothing live → any human gate makes the graph "needs you".
  if (highestAttentionReason !== null)
    return { graphState: "attention", activeWorkerCount, highestAttentionReason };

  // 3. Settled? (base column, not effective — deps are irrelevant once done.)
  const incomplete = nodes.filter((t) => resolveBaseColumn(t) !== "done");
  if (incomplete.length === 0)
    return { graphState: "done", activeWorkerCount, highestAttentionReason: null };

  // 4. Is there a runnable source? A planned node whose sibling deps are all
  //    satisfied can be dispatched → the graph is merely idle, not stuck.
  //    (By step 2, no incomplete node is review/blocked/attention here, so the
  //    only incomplete nodes are `planned`.) If NO planned node is runnable,
  //    every one waits on a non-done dep with no source ⇒ a blockedBy cycle
  //    (or work that only waits on a cycle) ⇒ deadlock.
  const hasRunnableSource = incomplete.some(
    (t) => resolveBaseColumn(t) === "planned" && areDependenciesSatisfied(t, byId),
  );
  return {
    graphState: hasRunnableSource ? "idle" : "deadlocked",
    activeWorkerCount,
    highestAttentionReason: null,
  };
}
```

### Why step 4 cleanly separates idle from deadlock

After steps 1–3, the incomplete set contains **only `planned` nodes** (running
is gone, `review`/`blocked` were routed to `attention`, `done` was filtered).
A `planned` node is _runnable_ iff `areDependenciesSatisfied` — i.e. it has no
unmet sibling dep. A finite DAG of planned nodes either has a topological source
(some node with all deps done/absent → runnable → **idle**, it will dispatch and
the rest follow) or it has none, which is only possible if there is a `blockedBy`
**cycle** among the planned nodes → **deadlock**. So deadlock here is precisely
"you wired a cycle," the exact footgun worth its own state. Dangling/cross-parent
deps never gate (`areDependenciesSatisfied` returns satisfied for them), so they
can't manufacture a false deadlock.

---

## 5. The active-worker count

```ts
activeWorkerCount = nodes.filter(isActiveWorker).length;
```

- **What counts:** a node with a genuinely-executing turn —
  `session.status === "running"` **or** `latestTurn.state === "running"`. This is
  the existing `hasRunningSignal` predicate, reused verbatim.
- **What does _not_ count:**
  - `status === "running"` with **no** live session/turn. That is a stale label,
    not a live worker. (Reused base-column logic treats it as the `running`
    _column_ for board display, but for the honest "work happening right now"
    headline we require a live signal.)
  - `connecting` sessions. A spinning-up worker is not yet doing work, so it does
    not inflate the headline number — but it **does** count as `isLive` for the
    _state_ gate (§4 step 1) so the row does not flicker through `idle`/`needs
you` during a reconnect. The two predicates differ on exactly this one case,
    deliberately.
- **Scope:** over **all descendants** (§6), so the "37" reflects the whole
  subtree, not just direct children.

The count is **orthogonal** to `graphState`: it is always meaningful and the UI
shows it whenever `≥ 1`, regardless of which pill wins (§7).

---

## 6. One-level children vs full descendants → **full descendants**

Children can themselves spawn children (lineage walks `parentThreadId` up to
depth 16, per `threadRouteLineage.ts`), so the rollup must choose a scope.

**Recommendation: roll up over all descendants** of the orchestrator.

Why:

- The orchestrator row claims to represent "my whole workstream." If a direct
  child is `review`/`done` but _its_ children are running, the orchestrator is
  still making progress — one-level rollup would report a false stall.
- The "1 vs 37" headline is precisely the deep number; one-level can only ever
  show direct-child counts and would badly undercount a real swarm.
- Liveness-dominance (§1) is only correct if liveness is detected _anywhere_
  beneath the orchestrator.

Cost / caveats (and why they're acceptable):

- **Dependency scope stays sibling-local.** `blockedBy` only gates among
  siblings (`areDependenciesSatisfied` checks `parentThreadId`). Feeding the full
  descendant map into that predicate is safe **because it does the sibling
  check** — a grandchild's dep id that happens to match an unrelated node won't
  gate. This is the reason §4 uses `areDependenciesSatisfied` rather than
  `getEffectiveColumn`'s inline dep loop, which omits the `parentThreadId` check
  (correct for one level of siblings, wrong across levels).
- **Cost.** Building the descendant set is a tree walk over the environment's
  thread summaries; bounded by the existing depth cap (16) and memoizable per
  orchestrator. Cheap relative to render.

> **Assumption:** the web store can enumerate descendants for an orchestrator
> (filter `sidebarThreadSummaryById` by transitive `parentThreadId`, mirroring
> `selectWorkstreamChildren` but recursive, with a depth/`visited` guard like
> `buildThreadLineage`). If only one level is readily available at the sidebar
> layer, ship one-level first and widen to full-descendant when the recursive
> selector lands — the algorithm itself is scope-agnostic.

---

## 7. Composition with the parent's OWN pill

The orchestrator row already derives the thread's **own** pill from its **own**
session via `resolveThreadStatusPill` (Working / Connecting / Pending Approval /
Awaiting Input / Plan Ready / Completed / null). Carl's constraint: **the
parent's own running / awaiting-approval state must still win for the parent's
own row.** The graph rollup augments, it does not mask, the orchestrator's own
live state.

Rule:

1. **If the parent's own pill is an _active or attention_ signal** — `Working`,
   `Connecting`, `Pending Approval`, `Awaiting Input`, or `Plan Ready` — it is
   the **primary** pill. The graph is shown only as secondary annotation (see
   badges below). _This is the literal "parent running/approval wins" rule._
2. **Otherwise** — the parent's own pill is `Completed` or `null` (the
   orchestrator finished or is idle) — the **graph rollup becomes the primary
   pill**:
   - `active` → "N working" (sky, pulse)
   - `attention` → "Needs you" (amber) + reason chip from `highestAttentionReason`
   - `deadlocked` → "Deadlocked" (red) — distinct, alarming, never auto-clears
   - `idle` → subtle / no strong pill (slate)
   - `done` → "Completed" (emerald; respect `hasUnseenCompletion` styling)
   - `empty` → fall back to the parent's own pill (which may be `null`)
3. **Always-on secondary badges, independent of which pill won:**
   - the **active-worker count** whenever `activeWorkerCount ≥ 1` — so a running
     orchestrator still shows "· 37 below," and a _finished_ orchestrator with a
     live swarm shows "37 working";
   - an **urgent graph chip** when the graph is `attention` or `deadlocked` while
     the parent's own pill outranks it — so a child needing approval (or a child
     cycle) is never fully hidden behind the orchestrator's own "Working."

This keeps the primary pill always describing the thread you land on when you
click the row, while the secondary badges describe the subtree — no ambiguity
about _where_ a signal lives.

> A unified single-pill ladder (à la `THREAD_STATUS_PRIORITY`, taking the max of
> self-pill and graph-pill) was considered and **rejected**: it would let a child
> deadlock or a child approval override the orchestrator's own "Working," which
> violates Carl's "parent's own state wins" constraint and hides _where_ the
> signal originates. The primary/secondary split above is the deliberate choice.

---

## 8. Edge cases (explicit)

| case                                                                                             | result                                                           | reasoning                                                                                                            |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Blocked-on-running** (node A `blocked`, blocker B running)                                     | `active`, count includes B                                       | §4 step 1 returns before A's local block is ever inspected. The graph is progressing.                                |
| **Blocked-on-human** (nothing running, A waits on B which is `review`/manual `blocked`/approval) | `attention`, reason set                                          | §4 step 2.                                                                                                           |
| **Cycle** (A `blockedBy` B, B `blockedBy` A, both planned, nothing running)                      | `deadlocked`                                                     | §4 step 4: no runnable source ⇒ cycle.                                                                               |
| **All-blocked, no source, no human gate**                                                        | `deadlocked`                                                     | same as cycle — work only waits on a cycle.                                                                          |
| **Ready planned, not yet dispatched**                                                            | `idle`                                                           | runnable source exists; about to start or manual.                                                                    |
| **Empty graph** (no descendants)                                                                 | `empty`, count 0                                                 | row shows parent's own pill.                                                                                         |
| **All done**                                                                                     | `done`, count 0                                                  | §4 step 3.                                                                                                           |
| **Mixed: some running, one needs approval**                                                      | `active`, count = running, `highestAttentionReason = "approval"` | liveness wins the state; the gate is still surfaced via the reason + chip.                                           |
| **Reconnect / session restart** (sessions `connecting`)                                          | `active` (not idle/needs-you), count may be 0                    | `isLive` includes `connecting`; prevents flicker. Headline count honestly reads the running ones (may briefly be 0). |
| **`error` session/turn**                                                                         | not live; contributes nothing special                            | falls to `idle`/`done` by base column. (Optional future: an `errored` reason — see §9.)                              |
| **Archived descendants**                                                                         | excluded entirely                                                | filtered first; archived ≠ active work.                                                                              |
| **Dangling / cross-parent `blockedBy`**                                                          | never gates                                                      | per `areDependenciesSatisfied`; cannot create a false deadlock.                                                      |

---

## 9. Assumptions & deferred questions

- **Errors aren't a graph state (yet).** A node with `session.status === "error"`
  or `latestTurn.state === "error"` currently falls through to `idle`/`done` by
  its base column. If failed turns should raise the row (they arguably "need
  you"), add an `"errored"` `AttentionReason` (priority above `plan`) and detect
  it in `attentionReasonOf`. Left out to keep the initial set minimal; flagged
  for the implementer to confirm with the user.
- **`review` urgency ranking.** Placed below `input` and above explicit
  `blocked`/`plan` in `ATTENTION_PRIORITY`. Tunable; it only affects which reason
  shows when several coexist, never the top-level `graphState`.
- **Full-descendant enumeration** must exist at the sidebar layer (§6). If not,
  ship one-level and widen later — the algorithm is scope-agnostic.
- **No backwards-compat shim.** This is new display logic; it replaces any naive
  "highest child column" rollup outright rather than coexisting with it.

---

## 10. Implementation pointers

- New pure helper (e.g. `apps/web/src/components/workstreamGraphState.ts` or
  alongside `Sidebar.logic.ts`): `rollupGraphState(descendants, byId)` exactly as
  §4. Pure, unit-testable, no React.
- Reuse `resolveBaseColumn` (export it from `WorkstreamPanel.tsx` or lift both it
  and `hasRunningSignal` into a shared module — they're currently file-private).
- Reuse `areDependenciesSatisfied` from
  `apps/server/src/orchestration/workstreamDependencies.ts` — or, if importing
  server code into web is undesirable, lift it to `packages/shared` (its doc
  comment already calls it "the one source of truth," so a shared home is
  justified). **Do not** re-derive dep satisfaction with `getEffectiveColumn`'s
  inline loop, which omits the sibling `parentThreadId` check.
- The sidebar row composes `resolveThreadStatusPill(parent)` (own) with
  `rollupGraphState(...)` (graph) per §7.
  </content>
  </invoke>
