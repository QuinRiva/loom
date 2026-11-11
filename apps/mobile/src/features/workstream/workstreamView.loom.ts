/**
 * loom: what the workstream screen, its breadcrumb and the Home badge read, all derived from the
 * environment's shell snapshot the Home list already holds. No thread detail, no stream: a card
 * shows what the shell carries and sends you to the child for the rest.
 */
import {
  type RollupIndex,
  rollupIndexOf,
  type WorkstreamAttentionReason,
  type WorkstreamBadge,
  workstreamBadgeOf,
  type WorkstreamRollup,
  workstreamRollupOf,
} from "@t3tools/client-runtime/state/loom/rollup";
import {
  type WorkstreamIndex,
  workstreamIndexOf,
} from "@t3tools/client-runtime/state/loom/workstream";
import {
  buildWorkstreamNodes,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
} from "@t3tools/client-runtime/state/loom/workstreamNodes";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { threadEnvironment } from "../../state/threads";

/** The family key every per-workstream atom and the view-state map take. */
export const workstreamKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  JSON.stringify([environmentId, threadId]);
const parseKey = (key: string) => JSON.parse(key) as [EnvironmentId, ThreadId];

export interface WorkstreamEnvironmentIndex {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly threadsById: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  readonly byId: WorkstreamIndex;
  readonly rollup: RollupIndex;
}

/** One index build per shell change, shared by the badges, the screen and the breadcrumb. */
export const workstreamEnvironmentIndexAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): WorkstreamEnvironmentIndex | null => {
    const threads = get(threadEnvironment.snapshotAtom(environmentId))?.threads;
    if (!threads) return null;
    return {
      threads,
      threadsById: new Map(threads.map((thread) => [thread.id, thread])),
      byId: workstreamIndexOf(threads),
      rollup: rollupIndexOf(threads),
    };
  }).pipe(Atom.withLabel(`loom-workstream-index:${environmentId}`)),
);

const EMPTY_BADGES: ReadonlyMap<ThreadId, WorkstreamBadge> = new Map();

/** Every root's Home badge in the environment, keyed by root id. */
export const workstreamBadgesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const index = get(workstreamEnvironmentIndexAtom(environmentId));
    if (!index) return EMPTY_BADGES;
    return new Map(
      index.threads
        .filter(
          (thread) =>
            thread.lineage.parentThreadId === null && index.rollup.childrenByParent.has(thread.id),
        )
        .map(
          (root) =>
            [
              root.id,
              workstreamBadgeOf(
                workstreamRollupOf(root.id, index.threads, index.byId, index.rollup),
              ),
            ] as const,
        ),
    );
  }).pipe(Atom.withLabel(`loom-workstream-badges:${environmentId}`)),
);

// The screen

/** A needs-you card's primary button: the first that applies, in this order. */
export type NeedsYouKind = "accept" | "answer" | "review" | "open";

export interface NeedsYouCard {
  readonly id: ThreadId;
  readonly kind: NeedsYouKind;
  /** The flag behind the card, or null for a question or approval with no flag. */
  readonly reason: WorkstreamAttentionReason | null;
  /** The blocking question, else the oldest one the child asked and carried on past. */
  readonly question: { readonly title: string | null; readonly since: string } | null;
}

export interface WorkstreamView {
  readonly root: { readonly id: ThreadId; readonly title: string };
  readonly rollup: WorkstreamRollup;
  /** The root and its live descendants; a node keeps its identity while its fields are equal. */
  readonly nodes: WorkstreamNodeIndex;
  /** Highest priority first: errors, then questions and approvals, then other flags. */
  readonly needsYou: ReadonlyArray<NeedsYouCard>;
}

const sameValue = (left: unknown, right: unknown) =>
  Object.is(left, right) ||
  (typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null &&
    JSON.stringify(left) === JSON.stringify(right));

const sameNode = (left: WorkstreamNode, right: WorkstreamNode) => {
  const keys = Object.keys(left) as Array<keyof WorkstreamNode>;
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => sameValue(left[key], right[key]))
  );
};

function needsYouOf(
  nodes: WorkstreamNodeIndex,
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  rollup: WorkstreamRollup,
): ReadonlyArray<NeedsYouCard> {
  const card = (shell: OrchestrationV2ThreadShell): NeedsYouCard | null => {
    const node = nodes.get(shell.id);
    if (!node) return null;
    const carried = shell.openQuestions?.[0];
    const question = node.pendingQuestion
      ? { title: node.pendingQuestion.header, since: node.pendingQuestion.since }
      : carried
        ? { title: carried.header, since: DateTime.formatIso(carried.createdAt) }
        : null;
    const kind: NeedsYouKind = node.reasons.includes("awaiting_acceptance")
      ? "accept"
      : question
        ? "answer"
        : node.pendingApproval
          ? "review"
          : "open";
    return { id: node.id, kind, reason: null, question };
  };
  const flagged = rollup.attention.nodes.filter((entry) => !entry.withAgents);
  const flaggedIds = new Set(flagged.map((entry) => entry.id));
  const shellsById = new Map(shells.map((shell) => [shell.id, shell]));
  const flaggedCards = flagged.flatMap((entry) => {
    const shell = shellsById.get(entry.id);
    const made = shell ? card(shell) : null;
    return made ? [{ ...made, reason: entry.reason }] : [];
  });
  const asking = shells
    .filter(
      (shell) =>
        !flaggedIds.has(shell.id) &&
        ((shell.openQuestions?.length ?? 0) > 0 ||
          nodes.get(shell.id)?.pendingQuestion != null ||
          nodes.get(shell.id)?.pendingApproval != null),
    )
    .flatMap((shell) => card(shell) ?? [])
    .sort((left, right) =>
      (left.question?.since ?? nodes.get(left.id)?.pendingApproval?.since ?? "").localeCompare(
        right.question?.since ?? nodes.get(right.id)?.pendingApproval?.since ?? "",
      ),
    );
  return [
    ...flaggedCards.filter((entry) => entry.reason === "error"),
    ...asking,
    ...flaggedCards.filter((entry) => entry.reason !== "error"),
  ];
}

/** One workstream's screen, keyed by `workstreamKey(environmentId, rootId)`; null until loaded. */
export const workstreamViewAtom = Atom.family((key: string) => {
  const [environmentId, rootId] = parseKey(key);
  let previous: WorkstreamView | null = null;
  return Atom.make((get): WorkstreamView | null => {
    const index = get(workstreamEnvironmentIndexAtom(environmentId));
    const root = index?.threadsById.get(rootId);
    if (!index || !root) return (previous = null);
    const subtree: OrchestrationV2ThreadShell[] = [root];
    for (let at = 0; at < subtree.length; at += 1)
      for (const child of index.rollup.childrenByParent.get(subtree[at]!.id) ?? [])
        subtree.push(index.threadsById.get(child.id)!);
    const descendants = subtree.slice(1);
    const built = buildWorkstreamNodes(subtree, index.byId);
    const nodes: WorkstreamNodeIndex = new Map(
      [...built].map(([id, node]) => {
        const before = previous?.nodes.get(id);
        return [id, before && sameNode(before, node) ? before : node] as const;
      }),
    );
    const rollup = workstreamRollupOf(rootId, index.threads, index.byId, index.rollup);
    const next: WorkstreamView = {
      root: { id: root.id, title: root.title },
      rollup,
      nodes,
      needsYou: needsYouOf(nodes, descendants, rollup),
    };
    const unchanged =
      previous !== null &&
      previous.root.title === next.root.title &&
      previous.nodes.size === nodes.size &&
      [...nodes].every(([id, node]) => previous!.nodes.get(id) === node) &&
      sameValue(previous.rollup, rollup) &&
      sameValue(previous.needsYou, next.needsYou);
    if (!unchanged) previous = next;
    return previous;
  }).pipe(Atom.withLabel(`loom-workstream-view:${key}`));
});

// The breadcrumb and header button on a thread screen

export interface WorkstreamCrumb {
  readonly rootId: ThreadId;
  readonly rootTitle: string;
  /** Sub-threads waiting on a human (the badge's `N!`). */
  readonly flagged: number;
  /** The thread is the root itself (header button, no breadcrumb). */
  readonly isRoot: boolean;
}

/**
 * The workstream a thread belongs to, keyed by `workstreamKey(environmentId, threadId)`: a
 * sub-thread's root, or the thread itself when it has sub-threads. Null otherwise.
 */
export const workstreamCrumbAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = parseKey(key);
  let previous: WorkstreamCrumb | null = null;
  return Atom.make((get): WorkstreamCrumb | null => {
    const index = get(workstreamEnvironmentIndexAtom(environmentId));
    const thread = index?.threadsById.get(threadId);
    const rootId = thread?.lineage.rootThreadId ?? threadId;
    const root = index?.threadsById.get(rootId);
    const badge = get(workstreamBadgesAtom(environmentId)).get(rootId);
    const next =
      thread && root && badge && badge.total > 0
        ? { rootId, rootTitle: root.title, flagged: badge.flagged, isRoot: rootId === threadId }
        : null;
    if (!sameValue(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.withLabel(`loom-workstream-crumb:${key}`));
});

// View state: which folds are open and where the list was scrolled, per workstream. In memory
// only (survives remounts and the swap between full screen and left pane, resets on reload).

/** The fold keys a person opened, keyed by `workstreamKey(environmentId, rootId)`. */
export const workstreamExpandedAtom = Atom.family((_key: string) =>
  Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive),
);

const scrollOffsets = new Map<string, number>();

export const rememberedScrollOffset = (key: string) => scrollOffsets.get(key) ?? 0;

export const rememberScrollOffset = (key: string, offset: number) => {
  scrollOffsets.set(key, offset);
};
