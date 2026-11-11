/**
 * loom: the workstream screen's lane graph as a list of rows, each drawing its own slice of the
 * lanes (`git log --graph` style), so rows window and grow with the font without the lines
 * coming apart. Pure, and its imports stay type-only so a scratch script can run it in plain
 * node. The rules are §3 of plans/mobile-workstream-view/plan.mdx.
 */
import type { WorkstreamNode } from "@t3tools/client-runtime/state/loom/workstreamNodes";
import type { ThreadId } from "@t3tools/contracts";

export type LaneNode = Pick<
  WorkstreamNode,
  | "id"
  | "parentThreadId"
  | "spawnGeneration"
  | "createdAt"
  | "outcome"
  | "blockedBy"
  | "routes"
  | "gateRounds"
>;

export interface ArcSlice {
  readonly slot: number;
  /** `gate`: reviewer to its rework target, solid. `waits`: a waiter's trunk to what holds it, dashed. */
  readonly kind: "waits" | "gate";
  readonly above: boolean;
  readonly below: boolean;
  /** `target` carries the arrowhead: the rework target of a gate, the waiter of a wait. */
  readonly joins: "none" | "source" | "target";
  /** The reviewer of a gate, the waiter of a wait: the round badge reads its node at render. */
  readonly sourceId: ThreadId;
}

export interface RowGutter {
  /** Which halves of the row carry each lane's vertical line (lanes with neither are omitted). */
  readonly lanes: ReadonlyArray<{
    readonly lane: number;
    readonly above: boolean;
    readonly below: boolean;
  }>;
  /** A branch from this row's glyph down to this lane, entering the next row from above. */
  readonly forkTo: number | null;
  readonly arcs: ReadonlyArray<ArcSlice>;
}

/** A sub-orchestrator's chevron: tap to expand a folded sub-tree, or collapse what is expanded. */
export interface ThreadFold {
  readonly expanded: boolean;
  /** Added to the expanded set when collapsed, removed from it when expanded. */
  readonly keys: ReadonlyArray<string>;
}

export type LaneRow =
  /** A root wave's caption, a square on the spine. Collapsible when `expanded` holds its key. */
  | {
      readonly kind: "wave";
      readonly key: string;
      readonly at: string;
      readonly count: number;
      readonly gutter: RowGutter;
    }
  | {
      readonly kind: "thread";
      readonly key: ThreadId;
      readonly lane: number;
      readonly orchestrator: boolean;
      readonly fold: ThreadFold | null;
      readonly gutter: RowGutter;
    }
  /**
   * A settled wave as one row; `threadIds` holds its members and their descendants. A root
   * wave's fold sits on the spine (lane 0). The counts are of the wave's members.
   */
  | {
      readonly kind: "fold";
      readonly key: string;
      readonly lane: number;
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly at: string;
      readonly settled: number;
      readonly cancelled: number;
      readonly gutter: RowGutter;
    };

export interface LaneLayout {
  readonly rows: ReadonlyArray<LaneRow>;
  readonly laneCount: number;
  readonly slotCount: number;
  /** Threads whose arrow found no slot; their row still names what they wait on. */
  readonly undrawn: ReadonlySet<ThreadId>;
}

export const MAX_LANES = 4;
export const MAX_SLOTS = 4;

/** Centre x of lane `n`, in dp. */
export const laneX = (lane: number) => 20 + 24 * lane;
/** Centre x of arc slot `s`, in dp. */
export const slotX = (slot: number, laneCount: number) => laneX(laneCount - 1) + 22 + 9 * slot;
export const gutterWidth = (laneCount: number, slotCount: number) =>
  slotCount > 0 ? slotX(slotCount - 1, laneCount) + 12 : laneX(laneCount - 1) + 18;

const loopTargets = (node: LaneNode) =>
  node.routes.flatMap((route) => (route.kind === "loop" && route.to ? [route.to] : []));

const newestFirst = (left: LaneNode, right: LaneNode) =>
  right.createdAt.localeCompare(left.createdAt);

/** What `layoutLanes` reads: a node change outside it (activity, step, flags) never re-lays. */
export const laneStructureKey = (nodes: ReadonlyArray<LaneNode>) =>
  nodes
    .map((node) =>
      [
        node.id,
        node.parentThreadId,
        node.spawnGeneration,
        node.createdAt,
        node.outcome,
        node.blockedBy.join(","),
        loopTargets(node).join(","),
        node.gateRounds > 0,
      ].join("|"),
    )
    .join("\n");

/** The expanded set after tapping a fold, a collapsible caption or a sub-orchestrator's chevron. */
export function toggleFold(expanded: ReadonlySet<string>, row: LaneRow): ReadonlySet<string> {
  const next = new Set(expanded);
  if (row.kind === "fold") next.add(row.key);
  else if (row.kind === "wave") next.delete(row.key);
  else if (row.fold?.expanded) for (const key of row.fold.keys) next.delete(key);
  else if (row.fold) for (const key of row.fold.keys) next.add(key);
  return next;
}

type DraftRow =
  | { readonly kind: "wave"; readonly key: string; readonly at: string; readonly count: number }
  | {
      readonly kind: "thread";
      readonly key: ThreadId;
      readonly lane: number;
      readonly orchestrator: boolean;
      fold: ThreadFold | null;
    }
  | {
      readonly kind: "fold";
      readonly key: string;
      readonly lane: number;
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly at: string;
      readonly settled: number;
      readonly cancelled: number;
    };

interface Span {
  readonly kind: "waits" | "gate";
  readonly sourceId: ThreadId;
  readonly lo: number;
  readonly hi: number;
  readonly sources: ReadonlySet<number>;
  readonly targets: ReadonlySet<number>;
}

/**
 * The rows, newest wave first, for `rootId`'s sub-tree in `nodes` (the root itself may be among
 * them). `expanded` holds the fold keys a person opened. Arcs that would push the gutter past
 * `maxGutterWidth` dp, or need more than `MAX_SLOTS` slots, are left undrawn.
 */
export function layoutLanes(
  nodes: ReadonlyArray<LaneNode>,
  rootId: ThreadId,
  expanded: ReadonlySet<string>,
  maxGutterWidth: number,
): LaneLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const kids = new Map<ThreadId, LaneNode[]>();
  for (const node of nodes) {
    if (node.id === rootId || node.parentThreadId === null) continue;
    const siblings = kids.get(node.parentThreadId);
    if (siblings) siblings.push(node);
    else kids.set(node.parentThreadId, [node]);
  }
  const childrenOf = (id: ThreadId) => kids.get(id) ?? [];

  const settledMemo = new Map<ThreadId, boolean>();
  const settled = (node: LaneNode): boolean => {
    let value = settledMemo.get(node.id);
    if (value === undefined) {
      value = node.outcome !== null && childrenOf(node.id).every(settled);
      settledMemo.set(node.id, value);
    }
    return value;
  };
  const subtree = (node: LaneNode): ThreadId[] => [
    node.id,
    ...childrenOf(node.id).flatMap(subtree),
  ];

  const wavesOf = (parentId: ThreadId) => {
    const groups = new Map<string, LaneNode[]>();
    for (const child of childrenOf(parentId)) {
      const generation = child.spawnGeneration ?? `solo:${child.id}`;
      const group = groups.get(generation);
      if (group) group.push(child);
      else groups.set(generation, [child]);
    }
    return [...groups]
      .map(([generation, members]) => ({
        key: `wave:${parentId}:${generation}`,
        members,
        at: members.map((member) => member.createdAt).sort()[0]!,
      }))
      .sort((left, right) => right.at.localeCompare(left.at));
  };

  // A thread sits above what it waits on: each thread nothing in the wave waits on, newest
  // first, followed depth first by its dependencies (blockedBy and its gate's rework target).
  const chain = (members: ReadonlyArray<LaneNode>) => {
    const inWave = new Map(members.map((member) => [member.id, member]));
    const deps = (member: LaneNode) =>
      [...new Set([...member.blockedBy, ...loopTargets(member)])]
        .flatMap((id) => (id !== member.id && inWave.has(id) ? [inWave.get(id)!] : []))
        .sort(newestFirst);
    const waitedOn = new Set(members.flatMap((member) => deps(member).map((dep) => dep.id)));
    const out: LaneNode[] = [];
    const seen = new Set<ThreadId>();
    const visit = (member: LaneNode) => {
      if (seen.has(member.id)) return;
      seen.add(member.id);
      out.push(member);
      for (const dep of deps(member)) visit(dep);
    };
    const newest = [...members].sort(newestFirst);
    for (const member of [...newest.filter((member) => !waitedOn.has(member.id)), ...newest])
      visit(member);
    return out;
  };

  const rows: DraftRow[] = [];
  const glyphLane: number[] = [];
  const rowOf = new Map<ThreadId, number>();
  const segments: Array<{ lane: number; from: number; to: number }> = [];
  const forkTo: Array<number | null> = [];
  const push = (row: DraftRow, lane: number) => {
    rows.push(row);
    glyphLane.push(lane);
    forkTo.push(null);
    return rows.length - 1;
  };
  const fold = (lane: number, key: string, members: ReadonlyArray<LaneNode>, at: string) => {
    const threadIds = members.flatMap(subtree);
    const index = push(
      {
        kind: "fold",
        key,
        lane,
        threadIds,
        at,
        settled: members.filter((member) => member.outcome === "done").length,
        cancelled: members.filter((member) => member.outcome === "cancelled").length,
      },
      lane,
    );
    for (const id of threadIds) rowOf.set(id, index);
    return index;
  };

  // Emits `member` and what hangs under it; returns its row.
  const emitThread = (member: LaneNode, lane: number) => {
    const children = childrenOf(member.id);
    const row: DraftRow = {
      kind: "thread",
      key: member.id,
      lane,
      orchestrator: children.length > 0,
      fold: null,
    };
    const index = push(row, lane);
    rowOf.set(member.id, index);
    if (children.length === 0) return index;
    if (settled(member) && !expanded.has(member.id)) {
      for (const id of subtree(member).slice(1)) rowOf.set(id, index);
      row.fold = { expanded: false, keys: [member.id] };
      return index;
    }
    const openKeys = emitChildren(member.id, index, lane);
    const keys = [...(expanded.has(member.id) && settled(member) ? [member.id] : []), ...openKeys];
    row.fold = keys.length > 0 ? { expanded: true, keys } : null;
    return index;
  };

  // A sub-orchestrator's waves, one lane in and without captions; returns the expanded fold keys.
  const emitChildren = (parentId: ThreadId, parentRow: number, parentLane: number) => {
    const lane = Math.min(parentLane + 1, MAX_LANES - 1);
    const openKeys: string[] = [];
    let last = parentRow;
    for (const wave of wavesOf(parentId)) {
      if (wave.members.every(settled)) {
        if (!expanded.has(wave.key)) {
          last = fold(lane, wave.key, wave.members, wave.at);
          continue;
        }
        openKeys.push(wave.key);
      }
      for (const member of chain(wave.members)) last = emitThread(member, lane);
    }
    if (last > parentRow) {
      segments.push({ lane, from: parentRow, to: last });
      if (lane !== parentLane) forkTo[parentRow] = lane;
    }
    return openKeys;
  };

  for (const wave of wavesOf(rootId)) {
    if (wave.members.every(settled) && !expanded.has(wave.key)) {
      fold(0, wave.key, wave.members, wave.at);
      continue;
    }
    const caption = push(
      { kind: "wave", key: wave.key, at: wave.at, count: wave.members.length },
      0,
    );
    forkTo[caption] = 1;
    let last = caption;
    for (const member of chain(wave.members)) last = emitThread(member, 1);
    segments.push({ lane: 1, from: caption, to: last });
  }
  const spine = glyphLane.flatMap((lane, index) => (lane === 0 ? [index] : []));
  if (spine.length > 1) segments.push({ lane: 0, from: spine[0]!, to: spine.at(-1)! });

  // Arcs: a gate while unresolved or once it has looped; one trunk per waiting thread to each
  // dependency that is not done. The gate stands in for the reviewer's dependency on its coder.
  const spans: Span[] = [];
  for (const node of nodes) {
    const here = rowOf.get(node.id);
    if (here === undefined) continue;
    const targets = loopTargets(node);
    for (const target of targets) {
      const there = rowOf.get(target);
      if (there === undefined || there === here) continue;
      if (node.outcome !== null && node.gateRounds === 0) continue;
      spans.push({
        kind: "gate",
        sourceId: node.id,
        lo: Math.min(here, there),
        hi: Math.max(here, there),
        sources: new Set([here]),
        targets: new Set([there]),
      });
    }
    if (node.outcome !== null) continue;
    const heldBy = new Set(
      node.blockedBy.flatMap((dep) => {
        const there = rowOf.get(dep);
        return there === undefined ||
          there === here ||
          targets.includes(dep) ||
          byId.get(dep)?.outcome === "done"
          ? []
          : [there];
      }),
    );
    if (heldBy.size === 0) continue;
    spans.push({
      kind: "waits",
      sourceId: node.id,
      lo: Math.min(here, ...heldBy),
      hi: Math.max(here, ...heldBy),
      sources: heldBy,
      targets: new Set([here]),
    });
  }

  const laneCount = Math.max(2, ...glyphLane.map((lane) => lane + 1));
  let slotLimit = 0;
  while (slotLimit < MAX_SLOTS && gutterWidth(laneCount, slotLimit + 1) <= maxGutterWidth)
    slotLimit += 1;
  const slots: Array<Array<readonly [number, number]>> = [];
  const placed: Array<{ span: Span; slot: number }> = [];
  const undrawn = new Set<ThreadId>();
  for (const span of [...spans].sort((left, right) => left.hi - left.lo - (right.hi - right.lo))) {
    const free = (used: ReadonlyArray<readonly [number, number]>) =>
      used.every(([lo, hi]) => span.hi < lo || span.lo > hi);
    let slot = slots.findIndex(free);
    if (slot < 0 && slots.length < slotLimit) slot = slots.push([]) - 1;
    if (slot < 0) {
      undrawn.add(span.sourceId);
      continue;
    }
    slots[slot]!.push([span.lo, span.hi]);
    placed.push({ span, slot });
  }

  const gutterOf = (index: number): RowGutter => {
    const lanes = [...new Set(segments.map((segment) => segment.lane))]
      .sort((left, right) => left - right)
      .flatMap((lane) => {
        const on = segments.filter((segment) => segment.lane === lane);
        const above = on.some((segment) => segment.from < index && index <= segment.to);
        const below = on.some(
          (segment) =>
            segment.from <= index &&
            index < segment.to &&
            !(segment.from === index && forkTo[index] === lane),
        );
        return above || below ? [{ lane, above, below }] : [];
      });
    const arcs = placed
      .filter(({ span }) => span.lo <= index && index <= span.hi)
      .map(({ span, slot }) => ({
        slot,
        kind: span.kind,
        above: index > span.lo,
        below: index < span.hi,
        joins: span.targets.has(index)
          ? ("target" as const)
          : span.sources.has(index)
            ? ("source" as const)
            : ("none" as const),
        sourceId: span.sourceId,
      }));
    return { lanes, forkTo: forkTo[index] ?? null, arcs };
  };

  return {
    rows: rows.map((row, index) => ({ ...row, gutter: gutterOf(index) })),
    laneCount,
    slotCount: slots.length,
    undrawn,
  };
}
