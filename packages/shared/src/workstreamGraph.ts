import {
  DEFAULT_GATE_MAX_ROUNDS,
  type AttentionReason,
  type ThreadFanInState,
  type ThreadId,
  type ThreadPlanLane,
  type WorkOutcomeDecision,
  type WorkstreamRoute,
} from "@t3tools/contracts";

/**
 * workstreamGraph - the single pure source of truth for the workstream graph:
 * structure (lineage), membership (which threads share one orchestration tree),
 * and the generation join the dispatcher uses to wake a parent.
 *
 * Mirrors the `workstreamDependencies` precedent: a minimal structural node
 * shape both the read-model thread (`OrchestrationThread`) and the shell summary
 * (`OrchestrationThreadShell`) satisfy, plus pure predicates consumed by every
 * graph walker (dispatcher join, same-tree auth, discovery view) so they can
 * never disagree. No I/O.
 *
 * @module workstreamGraph
 */

/**
 * Minimal structural node shape. Both `OrchestrationThread` and
 * `OrchestrationThreadShell` satisfy it. Lineage (`parentThreadId`) is the only
 * edge needed for structure + membership; generation grouping reads
 * `spawnGeneration`/`status`.
 */
export interface GraphThread extends GraphLineageNode {
  readonly spawnGeneration: string | null;
  readonly planLane: ThreadPlanLane;
  readonly attention: ReadonlyArray<AttentionReason>;
  readonly role: string | null;
  readonly title: string | null;
}

/**
 * The minimal lineage shape the structural walkers (root/descendants/subtree)
 * actually read: an id and its parent edge. Both the full `GraphThread` and the
 * leaner cost-rollup node satisfy it, so the same index/walk serves both.
 */
export interface GraphLineageNode {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
}

interface GraphIndex<T extends GraphLineageNode> {
  readonly byId: ReadonlyMap<ThreadId, T>;
  readonly childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<T>>;
}

/** Build the adjacency index once (id lookup + parent→children) from a node set. */
const buildIndex = <T extends GraphLineageNode>(threads: ReadonlyArray<T>): GraphIndex<T> => {
  const byId = new Map<ThreadId, T>();
  const childrenByParent = new Map<ThreadId, T[]>();
  for (const thread of threads) {
    byId.set(thread.id, thread);
    if (thread.parentThreadId !== null) {
      const siblings = childrenByParent.get(thread.parentThreadId);
      if (siblings) siblings.push(thread);
      else childrenByParent.set(thread.parentThreadId, [thread]);
    }
  }
  return { byId, childrenByParent };
};

/**
 * Walk ancestors to the root orchestrator. The root is the first node reached
 * with `parentThreadId === null` (a top-level thread). A node whose parent is
 * unknown (dangling/out-of-snapshot) is its own subtree root; a cycle is broken
 * by a visited guard, returning the id where the walk re-enters itself.
 */
const rootOf = <T extends GraphLineageNode>(id: ThreadId, index: GraphIndex<T>): ThreadId => {
  const seen = new Set<ThreadId>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const node = index.byId.get(current);
    if (node === undefined || node.parentThreadId === null) return current;
    current = node.parentThreadId;
  }
};

/** Direct children of a node (empty when it has none / is unknown). */
export const childrenOf = <T extends GraphLineageNode>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => buildIndex(threads).childrenByParent.get(id) ?? [];

const collectDescendants = <T extends GraphLineageNode>(
  id: ThreadId,
  index: GraphIndex<T>,
  out: T[],
  seen: Set<ThreadId>,
): void => {
  for (const child of index.childrenByParent.get(id) ?? []) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    out.push(child);
    collectDescendants(child.id, index, out, seen);
  }
};

/** All transitive descendants of a node (excludes the node itself). */
export const descendantsOf = <T extends GraphLineageNode>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const out: T[] = [];
  collectDescendants(id, buildIndex(threads), out, new Set([id]));
  return out;
};

/** The node plus all its transitive descendants (the whole subtree rooted at it). */
export const subtreeOf = <T extends GraphLineageNode>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const index = buildIndex(threads);
  const node = index.byId.get(id);
  const out: T[] = node ? [node] : [];
  collectDescendants(id, index, out, new Set([id]));
  return out;
};

/**
 * A lineage node that also carries its own cumulative dollar cost — the input to
 * the context cost meter's subtree rollup. `cumulativeCostUsd` is each thread's
 * OWN spend; null/absent counts as 0 (e.g. providers that report no cost).
 */
export interface CostGraphNode extends GraphLineageNode {
  readonly cumulativeCostUsd?: number | null | undefined;
}

/**
 * Total cost of the whole subtree rooted at `id` (the node plus all transitive
 * descendants), summing each node's own `cumulativeCostUsd`. Pure; reuses the
 * same lineage walk as `subtreeOf`, so a thread sitting at the orchestrator root
 * sees its entire workstream's spend.
 */
export const subtreeCostOf = <T extends CostGraphNode>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): number => subtreeOf(id, threads).reduce((sum, node) => sum + (node.cumulativeCostUsd ?? 0), 0);

/**
 * A child is "terminal" for the join barrier (design §6) ONLY when its plan
 * lane is `done`/`cancelled`. Attention flags and runtime state never count:
 * a flagged, non-executing child (a human stop, `awaiting_acceptance`, a stall
 * escalation) means the generation is PAUSED, not finished — the parent hears
 * about the pause promptly through the per-child notice rail in
 * `WorkstreamDispatcher`, never by firing this barrier. Joining only on genuine
 * plan terminality also keeps the one-shot generation wake from being consumed
 * by a momentary pause, so a resumed child's real completion always wakes the
 * parent. Only `done` releases dependents (that stays done-only in
 * `workstreamDependencies`).
 */
export interface TerminalForJoinNode {
  readonly planLane: ThreadPlanLane;
}

export const isTerminalForJoin = (node: TerminalForJoinNode): boolean =>
  node.planLane === "done" || node.planLane === "cancelled";

/** The fields the generation join reads. */
type JoinGroupThread = {
  readonly parentThreadId: ThreadId | null;
  readonly spawnGeneration: string | null;
} & TerminalForJoinNode;

export interface JoinedGeneration<T> {
  readonly parentId: ThreadId;
  readonly generation: string;
  readonly children: ReadonlyArray<T>;
}

/**
 * Pure generation-join selection: group every sub-thread by
 * (parentThreadId, spawnGeneration) and return the groups in which **every**
 * member is terminal. Generic over the concrete node type so the dispatcher gets
 * back full shells. Generation grouping stays internal — no consumer needs a
 * standalone `groupByGeneration`.
 *
 * Eligibility is a pure function of durable thread state, so it is fully
 * recomputable from the read model after a restart.
 */
export const selectJoinedGenerations = <T extends JoinGroupThread>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<JoinedGeneration<T>> => {
  const groups = new Map<string, { parentId: ThreadId; generation: string; children: T[] }>();
  for (const thread of threads) {
    if (thread.parentThreadId === null || thread.spawnGeneration === null) continue;
    const key = `${thread.parentThreadId}::${thread.spawnGeneration}`;
    const group = groups.get(key);
    if (group) group.children.push(thread);
    else
      groups.set(key, {
        parentId: thread.parentThreadId,
        generation: thread.spawnGeneration,
        children: [thread],
      });
  }
  return [...groups.values()].filter((group) =>
    group.children.every((child) => isTerminalForJoin(child)),
  );
};

// ---------------------------------------------------------------------------
// Review gates (docs/design/workstream-review-gates.md §4–§6) — the pure gate
// predicates + the submit routing decision, shared by the decider (authoritative
// routing), the dispatcher (traversal/suppression), the submit endpoint
// (response echo + per-round report naming), and the web board (waiting badges).
// ---------------------------------------------------------------------------

const isTerminalLane = (lane: ThreadPlanLane): boolean => lane === "done" || lane === "cancelled";

/**
 * The minimal gate-party shape. Both `OrchestrationThread` (read model) and
 * `OrchestrationThreadShell` satisfy it. A GATE is not stored: it is the
 * derived pair (source = the thread carrying a loop route, target = that
 * route's `to`), unresolved while the source is non-terminal.
 */
export interface GateNode {
  readonly id: ThreadId;
  readonly planLane: ThreadPlanLane;
  readonly routes: ReadonlyArray<WorkstreamRoute>;
  readonly gateRounds: number;
  readonly pendingRework: boolean;
  readonly lastOutcome: { readonly decision: WorkOutcomeDecision } | null;
}

/** The loop-edge target a gate source routes rework to, or null when none. */
export const gateLoopTargetOf = (thread: {
  readonly routes: ReadonlyArray<WorkstreamRoute>;
}): ThreadId | null =>
  thread.routes.find((route) => route.kind === "loop" && route.to !== undefined)?.to ?? null;

/** The non-terminal gate source whose loop route names `threadId`, or null. */
export const gateSourceFor = <T extends GateNode>(
  threadId: ThreadId,
  threads: ReadonlyArray<T>,
): T | null =>
  threads.find(
    (thread) =>
      !isTerminalLane(thread.planLane) &&
      thread.routes.some((route) => route.kind === "loop" && route.to === threadId),
  ) ?? null;

/**
 * Gate-waiting is not "forgot to finish" (design §6): true when the thread
 * participates in an unresolved gate and the protocol has parked it — the
 * source after it looped findings to the target (including while the target
 * holds the open rework round), or the target that routed back and awaits the
 * source's re-verify. A cancelled counterpart never suppresses (risk R4: the
 * waiting party's idle wake un-suppresses so the orchestrator hears about the
 * dead gate).
 */
export const isWaitingInGate = (
  thread: GateNode,
  threadsById: ReadonlyMap<ThreadId, GateNode>,
): boolean => {
  if (isTerminalLane(thread.planLane)) return false;
  // Source waiting: the target holds the open rework round, or the source has
  // looped and the target is either still active/yielded or has routed back for
  // re-verify. A plain terminal target with no routed-back outcome is a dead
  // gate, not a parked one. A cancelled target deliberately un-suppresses.
  const loopTo = gateLoopTargetOf(thread);
  if (loopTo !== null) {
    const target = threadsById.get(loopTo);
    if (
      target !== undefined &&
      target.planLane !== "cancelled" &&
      (target.pendingRework ||
        (thread.lastOutcome?.decision === "loop" &&
          (target.lastOutcome?.decision === "loop" || !isTerminalLane(target.planLane))))
    ) {
      return true;
    }
  }
  // Target waiting: it routed its rework back (its last outcome was the
  // intercepted `loop`) and the non-terminal source owes the re-verify.
  if (!thread.pendingRework && thread.lastOutcome?.decision === "loop") {
    for (const other of threadsById.values()) {
      if (
        other.id !== thread.id &&
        !isTerminalLane(other.planLane) &&
        other.routes.some((route) => route.kind === "loop" && route.to === thread.id)
      ) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Generation-join gating (design §6): true when the thread is a party of an
 * unresolved gate — a non-terminal loop-route source, or the target of a loop
 * route whose source is non-terminal. The dispatcher holds back any joined
 * generation containing such a member so a coder-only generation never joins
 * mid-loop (its round-0 `done` is reopenable until the gate resolves).
 */
export const isMemberOfUnresolvedGate = (
  thread: Pick<GateNode, "id" | "planLane" | "routes">,
  threads: ReadonlyArray<Pick<GateNode, "id" | "planLane" | "routes">>,
): boolean =>
  (!isTerminalLane(thread.planLane) && gateLoopTargetOf(thread) !== null) ||
  threads.some(
    (other) =>
      !isTerminalLane(other.planLane) &&
      other.routes.some((route) => route.kind === "loop" && route.to === thread.id),
  );

/**
 * Bypass guard (design §5.3): a gate party may not SELF-set `done` around the
 * routing — an open rework round or an unresolved gate as source must complete
 * through `workstream_submit`. Applies only to self-sets at the lane endpoint;
 * parent/human overrides deliberately bypass it (decision 9).
 */
export const requiresSubmitToComplete = (
  thread: Pick<GateNode, "planLane" | "routes" | "pendingRework">,
): boolean =>
  !isTerminalLane(thread.planLane) && (thread.pendingRework || gateLoopTargetOf(thread) !== null);

/** The routing verdict for one `thread.work.submit`, decided purely (§4.3). */
export interface WorkSubmitRouting {
  readonly decision: WorkOutcomeDecision;
  /** Round recorded on the outcome; advances only on a source loop traversal. */
  readonly round: number;
  /** Recipient of the `thread.route-taken` traversal (loop decisions only). */
  readonly routeTo: ThreadId | null;
  /** Gate counterpart to complete alongside (resolve only; null when none or already terminal). */
  readonly resolveWith: ThreadId | null;
}

/**
 * The single routing decision for a submitted outcome (design §4.3), consulted
 * by the decider (authoritative — the emitted events follow it) and mirrored by
 * the submit endpoint (response echo, per-round report naming):
 *
 * - `needs_human` → `attention` (the reserved human flag; lane untouched).
 * - A source outcome matching a loop route → `loop` while rounds remain
 *   (round = gateRounds + 1), `cap-breach` at the cap; a cancelled/missing
 *   loop target degrades to `yield` (risk R4 — never route into a dead thread).
 * - A source outcome matching a resolve route → `resolve`, completing the
 *   non-terminal counterpart alongside.
 * - Any non-`needs_human` outcome from a target with an open rework round →
 *   intercepted `loop` back to the source (round = the source's open round).
 * - Otherwise: `done` → `terminal`, anything else → `yield` (escalation is the
 *   safe default — no outcome can silently become done outside a rework round).
 */
export const routeWorkSubmit = <T extends GateNode>(
  thread: T,
  threads: ReadonlyArray<T>,
  outcome: string,
): WorkSubmitRouting => {
  const base = { round: thread.gateRounds, routeTo: null, resolveWith: null };
  if (outcome === "needs_human") return { ...base, decision: "attention" };
  if (outcome !== "done") {
    const route = thread.routes.find((entry) => entry.on.includes(outcome));
    if (route?.kind === "loop" && route.to !== undefined) {
      const target = threads.find((entry) => entry.id === route.to);
      if (target === undefined || target.planLane === "cancelled") {
        return { ...base, decision: "yield" };
      }
      return thread.gateRounds < (route.maxRounds ?? DEFAULT_GATE_MAX_ROUNDS)
        ? { ...base, decision: "loop", round: thread.gateRounds + 1, routeTo: route.to }
        : { ...base, decision: "cap-breach" };
    }
    if (route?.kind === "resolve") {
      const loopTo = gateLoopTargetOf(thread);
      const counterpart =
        loopTo === null ? undefined : threads.find((entry) => entry.id === loopTo);
      return {
        ...base,
        decision: "resolve",
        resolveWith:
          counterpart !== undefined && !isTerminalLane(counterpart.planLane)
            ? counterpart.id
            : null,
      };
    }
  }
  if (thread.pendingRework) {
    const source = gateSourceFor(thread.id, threads);
    if (source !== null) {
      return { ...base, decision: "loop", round: source.gateRounds, routeTo: source.id };
    }
  }
  return { ...base, decision: outcome === "done" ? "terminal" : "yield" };
};

/** The richer node shape the discovery view needs (lineage + report + waits-on). */
export interface GraphViewThread extends GraphThread {
  readonly reportPath: string | null;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  /** Projection freshness timestamp — a lightweight liveness signal. */
  readonly lastActivityAt: string | null;
  /** One-line preview of the most recent activity (full detail lives in the jsonl). */
  readonly lastActivitySummary: string | null;
  /** Worktree isolation fan-in settlement state (plan §3): "none", "completed", or "conflicted". */
  readonly fanInState: ThreadFanInState;
}

export interface GraphViewNode {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly role: string | null;
  readonly title: string | null;
  readonly planLane: ThreadPlanLane;
  readonly attention: ReadonlyArray<AttentionReason>;
  readonly spawnGeneration: string | null;
  readonly hasReport: boolean;
  /** Absolute path to the thread's curated report, or null if none filed. */
  readonly reportPath: string | null;
  /** Absolute path to the thread's pi session jsonl (full history), or null if not yet on disk. */
  readonly sessionPath: string | null;
  /** Projection freshness timestamp — a lightweight liveness signal. */
  readonly lastActivityAt: string | null;
  /** One-line preview of the most recent activity. */
  readonly lastActivitySummary: string | null;
  /** Worktree isolation fan-in settlement state (plan §3): "none" (no fan-in pending or not isolated), "completed" (merged cleanly), or "conflicted" (merge aborted, awaiting resolution). */
  readonly fanInState: ThreadFanInState;
}

export interface GraphEdge {
  readonly from: ThreadId;
  readonly to: ThreadId;
}

export interface GraphView {
  readonly rootId: ThreadId;
  readonly callerId: ThreadId;
  readonly nodes: ReadonlyArray<GraphViewNode>;
  /** Lineage edges, parent → child. */
  readonly lineageEdges: ReadonlyArray<GraphEdge>;
  /** Waits-on edges, blocked thread → dependency (within the tree). */
  readonly waitsOnEdges: ReadonlyArray<GraphEdge>;
}

/**
 * The discovery payload: the caller's whole workstream tree (rooted at the
 * caller's root orchestrator) as nodes + lineage edges + waits-on edges. This is
 * exactly the scope the same-tree auth predicate covers — you can only read/ask
 * what `list` shows you. Lean by construction (no message/activity bodies).
 */
export const graphViewFor = <T extends GraphViewThread>(
  callerId: ThreadId,
  threads: ReadonlyArray<T>,
  sessionPathFor?: (id: ThreadId) => string | null,
): GraphView => {
  const index = buildIndex(threads);
  const rootId = rootOf(callerId, index);
  const members = subtreeOf(rootId, threads);
  const memberIds = new Set(members.map((thread) => thread.id));
  const nodes: GraphViewNode[] = members.map((thread) => ({
    id: thread.id,
    parentThreadId: thread.parentThreadId,
    role: thread.role,
    title: thread.title,
    planLane: thread.planLane,
    attention: thread.attention,
    spawnGeneration: thread.spawnGeneration,
    hasReport: thread.reportPath !== null,
    reportPath: thread.reportPath,
    sessionPath: sessionPathFor ? sessionPathFor(thread.id) : null,
    lastActivityAt: thread.lastActivityAt,
    lastActivitySummary: thread.lastActivitySummary,
    fanInState: thread.fanInState,
  }));
  const lineageEdges = members.flatMap((thread) =>
    thread.parentThreadId !== null && memberIds.has(thread.parentThreadId)
      ? [{ from: thread.parentThreadId, to: thread.id }]
      : [],
  );
  const waitsOnEdges = members.flatMap((thread) =>
    thread.blockedBy.flatMap((depId) =>
      memberIds.has(depId) ? [{ from: thread.id, to: depId }] : [],
    ),
  );
  return { rootId, callerId, nodes, lineageEdges, waitsOnEdges };
};
