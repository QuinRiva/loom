import {
  DEFAULT_GATE_MAX_ROUNDS,
  type LoomAttentionReason,
  type LoomOutcome,
  type LoomThreadWorkstream,
  RESERVED_OUTCOMES,
  type ThreadId,
  type WorkOutcomeDecision,
  type WorkstreamRoute,
} from "@t3tools/contracts";

/**
 * The single pure source of truth for the workstream graph (lineage, tree membership, the
 * dispatcher's generation join): a minimal node shape both `OrchestrationThread` and
 * `OrchestrationThreadShell` satisfy, and predicates every graph walker shares so none disagree.
 *
 * @module workstreamGraph
 */

/**
 * Minimal structural node shape; the sidecar record (`LoomThreadWorkstream`,
 * keyed `threadId`) maps onto it with `id`. Lineage (`parentThreadId`) is the
 * only edge needed for structure + membership; generation grouping reads
 * `spawnGeneration`/`outcome`.
 */
export interface GraphThread extends GraphLineageNode {
  readonly spawnGeneration: string | null;
  readonly outcome: LoomOutcome | null;
  readonly attention: ReadonlyArray<LoomAttentionReason>;
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
const rootOfInIndex = <T extends GraphLineageNode>(
  id: ThreadId,
  index: GraphIndex<T>,
): ThreadId => {
  const seen = new Set<ThreadId>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const node = index.byId.get(current);
    // Root when: the node is a top-level thread (null parent), unknown itself,
    // or its parent is dangling/out-of-snapshot — in the last case `current`
    // (not the phantom parent) is the subtree root.
    if (node === undefined || node.parentThreadId === null || !index.byId.has(node.parentThreadId))
      return current;
    current = node.parentThreadId;
  }
};

/** The root orchestrator of the tree containing `id` (builds the index internally). */
export const rootOf = <T extends GraphLineageNode>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): ThreadId => rootOfInIndex(id, buildIndex(threads));

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

/** An outcome is set — `done` or `cancelled`: the thread's work is settled. */
export const isTerminal = (outcome: LoomOutcome | null): boolean => outcome !== null;

/**
 * A child is terminal for parent noticing ONLY when it has an outcome. A flagged, non-executing
 * child is PAUSED: the parent hears via the per-child notice rail, not the terminal-child delta
 * rail. Only `done` releases dependents (see `workstreamDependencies`).
 */
export interface TerminalForJoinNode {
  readonly outcome: LoomOutcome | null;
}

export const isTerminalForJoin = (node: TerminalForJoinNode): boolean => isTerminal(node.outcome);

// Review gates (docs/design/workstream-review-gates.md §4–§6) — the pure gate
// predicates + the submit routing decision, shared by the decider (authoritative
// routing), the dispatcher (traversal/suppression), the submit endpoint
// (response echo + per-round report naming), and the web graph (waiting badges).

/**
 * The minimal gate-party shape. A GATE is not stored: it is the derived set
 * (source = the thread carrying loop routes, targets = those routes' `to`),
 * unresolved while the source is non-terminal.
 */
export interface GateNode {
  readonly id: ThreadId;
  readonly outcome: LoomOutcome | null;
  readonly routes: ReadonlyArray<WorkstreamRoute>;
  readonly gateRounds: number;
  readonly pendingRework: boolean;
  readonly lastOutcome: { readonly decision: WorkOutcomeDecision; readonly round: number } | null;
}

/** The loop-edge targets a gate source routes rework to (empty when it gates nothing). */
export const gateLoopTargetsOf = (thread: {
  readonly routes: ReadonlyArray<WorkstreamRoute>;
}): ReadonlyArray<ThreadId> =>
  thread.routes.flatMap((route) =>
    route.kind === "loop" && route.to !== undefined ? [route.to] : [],
  );

/** The non-terminal gate source whose loop route names `threadId`, or null. */
export const gateSourceFor = <T extends GateNode>(
  threadId: ThreadId,
  threads: ReadonlyArray<T>,
): T | null =>
  threads.find(
    (thread) =>
      !isTerminal(thread.outcome) &&
      thread.routes.some((route) => route.kind === "loop" && route.to === threadId),
  ) ?? null;

/**
 * True when the protocol has parked the thread in an unresolved gate: the source after looping
 * findings to a target still in this round, or a target routed back awaiting re-verify (even if
 * terminal). False when no counterpart is left that anything re-drives, so the idle wake surfaces it.
 */
export const isWaitingInGate = (
  thread: GateNode,
  threadsById: ReadonlyMap<ThreadId, GateNode>,
): boolean => {
  if (isTerminal(thread.outcome)) return false;
  // A plain terminal or cancelled target is a dead gate, not a parked one. A sibling that routed
  // back in an earlier round and was not reopened is not this round's; a lone target always is,
  // so a one-sibling gate reads exactly as before.
  const targets = gateLoopTargetsOf(thread);
  if (
    targets.some((loopTo) => {
      const target = threadsById.get(loopTo);
      if (target === undefined || target.outcome === "cancelled") return false;
      if (target.pendingRework && !isTerminal(target.outcome)) return true;
      const routedBack = target.lastOutcome?.decision === "loop";
      return (
        thread.lastOutcome?.decision === "loop" &&
        (routedBack || !isTerminal(target.outcome)) &&
        (targets.length === 1 || !routedBack || target.lastOutcome!.round === thread.gateRounds)
      );
    })
  ) {
    return true;
  }
  // Target waiting: it routed its rework back (its last outcome was the
  // intercepted `loop`) and the non-terminal source owes the re-verify.
  if (!thread.pendingRework && thread.lastOutcome?.decision === "loop") {
    for (const other of threadsById.values()) {
      if (
        other.id !== thread.id &&
        !isTerminal(other.outcome) &&
        other.routes.some((route) => route.kind === "loop" && route.to === thread.id)
      ) {
        return true;
      }
    }
  }
  return false;
};

/** The sidecar fields the keep-alive predicate reads beyond a GateNode. */
export type KeepAliveNode = GateNode &
  Pick<
    LoomThreadWorkstream,
    "attention" | "held" | "kickoffAt" | "blockedBy" | "archivedAt" | "deletedAt"
  >;

/**
 * The gate counterpart a submitted thread is parked on, or null when no hand-back is coming soon:
 * the thread is flagged, or the counterpart is cancelled, archived, deleted, flagged, or neither
 * launched nor launchable. Idle cache warming keeps the cache warm while it holds: gate hand-backs
 * landed within 30 minutes nine times in ten, against pi's 15% idle-reply estimate.
 */
export const gateKeepAliveCounterpart = <T extends KeepAliveNode>(
  thread: T,
  siblings: ReadonlyArray<T>,
): T | null => {
  if (thread.attention.length > 0) return null;
  const byId = new Map(siblings.map((sibling) => [sibling.id, sibling]));
  const targets = gateLoopTargetsOf(thread).flatMap((id) => byId.get(id) ?? []);
  const counterpart =
    thread.outcome === "done"
      ? gateSourceFor(thread.id, siblings)
      : isWaitingInGate(thread, byId)
        ? (targets.find((target) => target.pendingRework) ??
          targets[0] ??
          gateSourceFor(thread.id, siblings))
        : null;
  if (
    !counterpart ||
    counterpart.outcome === "cancelled" ||
    counterpart.attention.length > 0 ||
    counterpart.archivedAt !== null ||
    counterpart.deletedAt !== null
  )
    return null;
  return counterpart.kickoffAt !== null ||
    (!counterpart.held && counterpart.blockedBy.every((dep) => byId.get(dep)?.outcome === "done"))
    ? counterpart
    : null;
};

/**
 * True for a party of an unresolved gate: a non-terminal loop-route source, or a loop-route target
 * whose source is non-terminal. The dispatcher holds back joined generations containing one, so a
 * coder's round-0 `done` (reopenable until the gate resolves) never joins mid-loop.
 */
export const isMemberOfUnresolvedGate = (
  thread: Pick<GateNode, "id" | "outcome" | "routes">,
  threads: ReadonlyArray<Pick<GateNode, "id" | "outcome" | "routes">>,
): boolean =>
  (!isTerminal(thread.outcome) && gateLoopTargetsOf(thread).length > 0) ||
  unresolvedGateSourcesOf(thread.id, threads).length > 0;

/**
 * Every non-terminal gate source (reviewer) whose loop route names `threadId`.
 */
export const unresolvedGateSourcesOf = <T extends Pick<GateNode, "id" | "outcome" | "routes">>(
  threadId: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> =>
  threads.filter(
    (other) =>
      !isTerminal(other.outcome) &&
      other.routes.some((route) => route.kind === "loop" && route.to === threadId),
  );

/**
 * Bypass guard (design §5.3): a gate party may not SELF-set `done` around the
 * routing — an open rework round or an unresolved gate as source must complete
 * through `mcp__t3-code__workstream_submit`. Applies only to self-sets of the outcome;
 * parent/human overrides deliberately bypass it (decision 9).
 */
export const requiresSubmitToComplete = (
  thread: Pick<GateNode, "outcome" | "routes" | "pendingRework">,
): boolean =>
  !isTerminal(thread.outcome) && (thread.pendingRework || gateLoopTargetsOf(thread).length > 0);

/** The routing verdict for one `thread.work.submit`, decided purely (§4.3). */
export interface WorkSubmitRouting {
  readonly decision: WorkOutcomeDecision;
  /** Round recorded on the outcome; advances only on a source loop traversal. */
  readonly round: number;
  /** Recipients of the `thread.route-taken` traversals, one each (loop decisions only). */
  readonly routeTo: ReadonlyArray<ThreadId>;
  /** Gate counterparts to complete alongside (resolve only; those not already terminal). */
  readonly resolveWith: ReadonlyArray<ThreadId>;
}

/** The caller's loop targets whose route loops on `outcome`: the gate siblings a verdict may reopen. */
const loopTargetsOn = (routes: ReadonlyArray<WorkstreamRoute>, outcome: string) =>
  routes.flatMap((route) =>
    route.kind === "loop" && route.to !== undefined && route.on.includes(outcome) ? [route.to] : [],
  );

/**
 * The single routing decision for a submitted outcome, followed by the decider and mirrored by the
 * submit endpoint. `quiescent` yields before the rework interception (a coder gone quiet is never
 * handing back); a loop verdict reopens the live siblings `rework` names (a one-sibling gate's when
 * none), else yields; only `done` is terminal and anything else yields (escalation is safe).
 */
export const routeWorkSubmit = <T extends GateNode>(
  thread: T,
  threads: ReadonlyArray<T>,
  outcome: string,
  rework?: ReadonlyArray<ThreadId>,
): WorkSubmitRouting => {
  const base = { round: thread.gateRounds, routeTo: [], resolveWith: [] };
  if (outcome === "quiescent") return { ...base, decision: "yield" };
  if (outcome === "needs_human") return { ...base, decision: "attention" };
  const live = (id: ThreadId, alive: (outcome: LoomOutcome | null) => boolean) => {
    const target = threads.find((entry) => entry.id === id);
    return target !== undefined && alive(target.outcome);
  };
  if (outcome !== "done") {
    const targets = loopTargetsOn(thread.routes, outcome);
    if (targets.length > 0) {
      const named = rework?.length ? rework : targets.length === 1 ? targets : [];
      const routeTo = targets.filter(
        (id) => named.includes(id) && live(id, (state) => state !== "cancelled"),
      );
      if (routeTo.length === 0) return { ...base, decision: "yield" };
      // One cap per gate: every loop route of a gate carries the same maxRounds.
      const cap =
        thread.routes.find((route) => route.kind === "loop" && route.on.includes(outcome))
          ?.maxRounds ?? DEFAULT_GATE_MAX_ROUNDS;
      return thread.gateRounds < cap
        ? { ...base, decision: "loop", round: thread.gateRounds + 1, routeTo }
        : { ...base, decision: "cap-breach" };
    }
    if (thread.routes.some((route) => route.kind === "resolve" && route.on.includes(outcome))) {
      return {
        ...base,
        decision: "resolve",
        resolveWith: gateLoopTargetsOf(thread).filter((id) =>
          live(id, (state) => !isTerminal(state)),
        ),
      };
    }
  }
  if (thread.pendingRework) {
    const source = gateSourceFor(thread.id, threads);
    if (source !== null) {
      return { ...base, decision: "loop", round: source.gateRounds, routeTo: [source.id] };
    }
  }
  return { ...base, decision: outcome === "done" ? "terminal" : "yield" };
};

/**
 * The attention reasons an agent may raise (for itself or a child it parents).
 * `error` and `awaiting_orchestrator` are server-only — the arm rejects them
 * without a `server:` command id.
 */
const RAISABLE_ATTENTION_REASONS: ReadonlySet<LoomAttentionReason> = new Set([
  "awaiting_acceptance",
  "needs_guidance",
]);

/**
 * The standing attention reason a COMPLETING submit (`terminal`/`resolve`, landing in `done`) would
 * erase, or null. Keyed on standing attention, not this turn's raise: only a human or the parent
 * clears a hold, whoever raised it. Raisers erasing their own `awaiting_acceptance` seconds later
 * released the very work the sign-off was meant to gate.
 */
export const holdErasedByCompletion = (input: {
  readonly attention: ReadonlyArray<LoomAttentionReason>;
  readonly decision: WorkOutcomeDecision;
}): LoomAttentionReason | null =>
  input.decision === "terminal" || input.decision === "resolve"
    ? (input.attention.find((reason) => RAISABLE_ATTENTION_REASONS.has(reason)) ?? null)
    : null;

/**
 * Why the arm refuses a `thread.work.submit` outright, or null: an agent claiming a reserved
 * outcome, a thread whose outcome is set (unless a gate rework reopens a `done` target), or a
 * `rework` that does not fit the caller's gate. The submit tool checks it before writing the
 * report, so a refused submit never replaces the record.
 */
export const workSubmitRefusal = (
  thread: Pick<GateNode, "id" | "outcome" | "pendingRework" | "routes">,
  outcome: string,
  decision: WorkOutcomeDecision,
  fromServer: boolean,
  rework?: ReadonlyArray<ThreadId>,
): string | null => {
  if ((RESERVED_OUTCOMES as ReadonlyArray<string>).includes(outcome) && !fromServer)
    return `Outcome '${outcome}' is reserved for the server.`;
  if (
    thread.outcome !== null &&
    !(thread.outcome === "done" && thread.pendingRework && decision === "loop")
  )
    return `Thread ${thread.id} is ${thread.outcome}; mcp__t3-code__workstream_submit cannot act on a terminal thread.`;
  const targets = loopTargetsOn(thread.routes, outcome);
  const listed = targets.join(", ");
  // loom: wording owned by step 8
  if (rework?.length && targets.length === 0)
    return `rework only accompanies an outcome your review gate loops on; '${outcome}' loops nothing.`;
  const stray = rework?.find((id) => !targets.includes(id));
  if (stray !== undefined)
    return `rework names ${stray}, which is not a sibling your gate loops on '${outcome}'; its siblings are: ${listed}.`;
  if (!rework?.length && targets.length > 1)
    return `Your review gate covers several siblings; '${outcome}' must name the ones to reopen in rework (any of: ${listed}).`;
  return null;
};
