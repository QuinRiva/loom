// Pure fork–join band layout for the Workstream graph. No JSX, no React — the
// SVG renderer (WorkstreamGraph.tsx) consumes the positioned nodes/edges this
// produces. Kept separate so the geometry (the one non-trivial, recursive piece)
// is unit-testable without mounting a component.
//
// Model: an orchestrator recurs as one BRIDGE node per wave, where a wave = the
// children sharing one (parentThreadId, spawnGeneration). Waves stack down a
// neutral spine ordered by each wave's earliest child; a wave's children sit in
// dependency columns to its right, with real `blockedBy` as within-wave
// cross-edges. A child that itself spawns is the same layout applied recursively
// and packed as a measured (w×h) block under its card.

import type { ThreadId } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";

export const BRIDGE_W = 150;
export const BRIDGE_H = 46;
// 172×74 (header-band card, docs/design/workstream-graph-node-redesign.html
// design C2): a role/state header strip, a two-line wrapped title, and a
// metrics band. Uniform (not per-state) so node geometry stays a function of
// STRUCTURE only — the layout is memoised on a status-excluding key, so a
// per-state height would re-run the whole fork–join layout on every lane/turn
// transition. Every port/centre/viewBox derives from these constants.
export const NODE_W = 172;
export const NODE_H = 74;
const FORK_GAP = 54; // bridge right edge → first child column
const COL_GAP = 50; // between dependency columns (room for blockedBy arrows)
const ROW_GAP = 18; // between stacked members in a column
const WAVE_GAP = 38; // between consecutive waves down the spine
const NEST_INDENT = 26; // a sub-orchestrator's nested block, indented under its card
const NEST_VGAP = 18; // card → its nested block
const LOOP_CHANNEL_DROP = 22; // horizontal loop channel sits this far below the gate pair's cards
// Extra vertical space reserved BELOW a wave's rows when that wave carries a
// review-gate loop, so the loop channel + badge live in a clear lane instead of
// cutting into the next row. Applied uniformly to every row of the wave so gate
// pairs stay horizontally aligned (the barycentre invariant is preserved).
const LOOP_CHANNEL_LANE = 26;
const LOOP_LANE_STEP = 8; // stagger for loop channels that would otherwise share a lane
const CHANNEL_MARGIN = 10; // clearance below an obstacle before a routed channel
const LANE_STEP = COL_GAP / 2; // step when searching outward for a clear vertical lane
const CONSULT_LANE_STEP = 9; // per-edge offset so shared consult channels never overlap

export type Point = { readonly x: number; readonly y: number };

// Rounded orthogonal polyline through a list of waypoints: straight segments
// joined by small quadratic corners. This is the dataflow-editor routing that
// keeps back-edges out of node bodies — they run in the gutters, not diagonally.
// Ported from the approved interaction mockup (workstream-panel-mockup.html).
export function roundedPath(points: ReadonlyArray<Point>, r = 9): string {
  if (points.length < 2) return "";
  if (points.length === 2)
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const a = { x: p1.x - ((p1.x - p0.x) / l1) * rr, y: p1.y - ((p1.y - p0.y) / l1) * rr };
    const c = { x: p1.x + ((p2.x - p1.x) / l2) * rr, y: p1.y + ((p2.y - p1.y) / l2) * rr };
    d += ` L ${a.x} ${a.y} Q ${p1.x} ${p1.y} ${c.x} ${c.y}`;
  }
  const e = points[points.length - 1]!;
  return `${d} L ${e.x} ${e.y}`;
}
export type ViewBox = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export type LaidNode =
  | {
      readonly kind: "bridge";
      readonly key: string;
      readonly orchestratorId: ThreadId;
      readonly label: string;
      readonly waveIndex: number;
      readonly anchorAtIso: string;
      x: number;
      y: number;
      readonly w: number;
      readonly h: number;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly thread: SidebarThreadSummary;
      x: number;
      y: number;
      readonly w: number;
      readonly h: number;
    };

export type EdgeKind = "spine" | "fork" | "blocked" | "loop";
export interface LaidEdge {
  readonly kind: EdgeKind;
  readonly key: string;
  /** Node keys the edge connects (bridge key or thread id), for dependency
   * highlight: hovering a node lights its incident edges + their neighbours. */
  readonly fromKey: string;
  readonly toKey: string;
  /** Gate source thread (loop edges only) — the renderer resolves live
   * `gateRounds`/`maxRounds` from it so round colour/badge track without re-layout. */
  readonly sourceId?: ThreadId;
  /** Orthogonal waypoints for a back-edge (loop). When present the renderer
   * draws a rounded polyline through these gutters instead of a diagonal that
   * would slice node bodies; x1/y1..x2/y2 stay the true endpoints. */
  points?: ReadonlyArray<Point>;
  /** Loop-edge badge anchor — a point on the straight channel run where the
   * `⟲ n/cap` pill rides (never on a corner). */
  badge?: Point;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Block {
  readonly nodes: LaidNode[];
  readonly edges: LaidEdge[];
  readonly w: number;
  readonly h: number;
}

function translate(block: Block, dx: number, dy: number): Block {
  for (const node of block.nodes) {
    node.x += dx;
    node.y += dy;
  }
  for (const edge of block.edges) {
    edge.x1 += dx;
    edge.y1 += dy;
    edge.x2 += dx;
    edge.y2 += dy;
    // Routed back-edges carry their own waypoints + badge anchor; a nested
    // block is placed by translation, so these must move with the endpoints or
    // a sub-orchestrator's loop would render in stale local coordinates.
    if (edge.points) edge.points = edge.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    if (edge.badge) edge.badge = { x: edge.badge.x + dx, y: edge.badge.y + dy };
  }
  return block;
}

/**
 * Order a wave's members into dependency columns by longest within-wave
 * `blockedBy` chain (depth 0 = no in-wave dependency). Cross-wave / dangling /
 * self deps don't count; cycles are broken by a visiting guard.
 */
function dependencyColumns(
  members: ReadonlyArray<SidebarThreadSummary>,
): ReadonlyArray<ReadonlyArray<SidebarThreadSummary>> {
  const ids = new Set(members.map((m) => m.id));
  const byId = new Map(members.map((m) => [m.id, m]));
  const depthCache = new Map<ThreadId, number>();
  const visiting = new Set<ThreadId>();
  const depth = (member: SidebarThreadSummary): number => {
    const cached = depthCache.get(member.id);
    if (cached !== undefined) return cached;
    if (visiting.has(member.id)) return 0;
    visiting.add(member.id);
    let d = 0;
    for (const dep of member.blockedBy) {
      const depNode = dep === member.id || !ids.has(dep) ? undefined : byId.get(dep);
      if (depNode) d = Math.max(d, depth(depNode) + 1);
    }
    visiting.delete(member.id);
    depthCache.set(member.id, d);
    return d;
  };
  const maxDepth = members.reduce((max, m) => Math.max(max, depth(m)), 0);
  const columns: SidebarThreadSummary[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const member of members) columns[depth(member)]!.push(member);
  // Barycentre pass: order each dependent column by the mean row of its in-wave
  // dependencies in earlier columns, so parallel chains (coder→reviewer pairs)
  // stay horizontal instead of criss-crossing when spawn order differs between
  // columns. Dep-less members sink below, keeping their createdAt order.
  const rowById = new Map<ThreadId, number>();
  columns.forEach((column, colIndex) => {
    if (colIndex > 0) {
      const barycentre = (member: SidebarThreadSummary): number => {
        const rows = member.blockedBy
          .map((dep) => rowById.get(dep))
          .filter((row): row is number => row !== undefined);
        return rows.length > 0
          ? rows.reduce((sum, row) => sum + row, 0) / rows.length
          : Number.POSITIVE_INFINITY;
      };
      column.sort(
        (a, b) => barycentre(a) - barycentre(b) || a.createdAt.localeCompare(b.createdAt),
      );
    }
    column.forEach((member, row) => rowById.set(member.id, row));
  });
  return columns;
}

const minCreatedAt = (members: ReadonlyArray<SidebarThreadSummary>): string =>
  members.reduce((min, m) => (m.createdAt < min ? m.createdAt : min), members[0]!.createdAt);

/**
 * Lay out one orchestrator's whole sub-flow in local coordinates (origin
 * top-left): a vertical spine of bridge nodes (one per wave) with that wave's
 * children in dependency columns to the right, recursing into sub-orchestrators.
 */
function layoutOrchestrator(
  orchestratorId: ThreadId,
  title: string,
  childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<SidebarThreadSummary>>,
): Block {
  const children = childrenByParent.get(orchestratorId) ?? [];
  if (children.length === 0) return { nodes: [], edges: [], w: 0, h: 0 };

  // Group strictly by (parentThreadId, spawnGeneration); out-of-turn spawns
  // (null generation) degrade to singleton waves keyed by the child's own id.
  const waves = new Map<string, SidebarThreadSummary[]>();
  for (const child of children) {
    const key = child.spawnGeneration ?? `solo:${child.id}`;
    const group = waves.get(key);
    if (group) group.push(child);
    else waves.set(key, [child]);
  }
  const waveOrder = [...waves.values()].sort((a, b) =>
    minCreatedAt(a).localeCompare(minCreatedAt(b)),
  );

  const nodes: LaidNode[] = [];
  const edges: LaidEdge[] = [];
  const bridgeCenters: Point[] = [];
  // One lane registry for all of this orchestrator's loop back-edges, so two
  // loops an obstacle collapses onto the same channel are pulled apart.
  const loopLanes = new BackEdgeLanes();
  let y = 0;
  let blockW = BRIDGE_W;
  // Card centres + wave index for EVERY member across all waves, so a
  // cross-wave dependency can be routed after the wave loop (the per-wave
  // `memberCardCenter` only sees one wave at a time).
  const centreByMember = new Map<ThreadId, Point>();
  const waveIndexByMember = new Map<ThreadId, number>();

  waveOrder.forEach((waveMembers, waveIndex) => {
    const members = [...waveMembers].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const memberIds = new Set(members.map((m) => m.id));
    // Members that participate in a within-wave review gate (loop source OR its
    // target). Each reserves a lane below its card for the loop channel so the
    // loop never cuts through its own nested descendant block.
    const loopParticipants = new Set<ThreadId>();
    for (const m of members) {
      for (const route of m.routes) {
        if (route.kind === "loop" && route.to !== undefined && memberIds.has(route.to)) {
          loopParticipants.add(m.id);
          loopParticipants.add(route.to);
        }
      }
    }
    const subBlockByMember = new Map<ThreadId, Block>(
      members.map((m) => [m.id, layoutMember(m, childrenByParent, loopParticipants.has(m.id))]),
    );
    // A wave that carries a review-gate loop reserves an extra row lane so the
    // loop channel never crosses the next row. The bump is uniform across every
    // row/column of the wave, so aligned gate pairs stay aligned.
    const waveHasLoop = loopParticipants.size > 0;
    const rowGap = waveHasLoop ? ROW_GAP + LOOP_CHANNEL_LANE : ROW_GAP;
    const columns = dependencyColumns(members);
    const colLayouts = columns.map((column) => {
      const blocks = column.map((m) => subBlockByMember.get(m.id)!);
      const colW = blocks.reduce((max, b) => Math.max(max, b.w), NODE_W);
      const colH = blocks.reduce((sum, b) => sum + b.h, 0) + rowGap * (column.length - 1);
      return { column, blocks, colW, colH };
    });
    const waveH = colLayouts.reduce((max, c) => Math.max(max, c.colH), BRIDGE_H);

    const bridgeY = y + (waveH - BRIDGE_H) / 2;
    const memberCardCenter = new Map<ThreadId, Point>();
    let cx = BRIDGE_W + FORK_GAP;
    for (const cl of colLayouts) {
      let cy = y + (waveH - cl.colH) / 2;
      cl.column.forEach((member, rowIndex) => {
        const placed = translate(cl.blocks[rowIndex]!, cx, cy);
        nodes.push(...placed.nodes);
        edges.push(...placed.edges);
        memberCardCenter.set(member.id, { x: cx, y: cy + NODE_H / 2 });
        cy += cl.blocks[rowIndex]!.h + rowGap;
      });
      cx += cl.colW + COL_GAP;
    }
    blockW = Math.max(blockW, cx - COL_GAP);
    for (const [id, centre] of memberCardCenter) {
      centreByMember.set(id, centre);
      waveIndexByMember.set(id, waveIndex);
    }

    const bridgeKey = `bridge:${orchestratorId}:${waveIndex}`;
    nodes.push({
      kind: "bridge",
      key: bridgeKey,
      orchestratorId,
      label: title,
      waveIndex: waveIndex + 1,
      anchorAtIso: minCreatedAt(members),
      x: 0,
      y: bridgeY,
      w: BRIDGE_W,
      h: BRIDGE_H,
    });
    bridgeCenters.push({ x: BRIDGE_W / 2, y: bridgeY + BRIDGE_H / 2 });

    // Fork: the bridge dispatches each entry (depth-0) member of its wave.
    for (const member of columns[0] ?? []) {
      const center = memberCardCenter.get(member.id)!;
      edges.push({
        kind: "fork",
        key: `fork:${orchestratorId}:${waveIndex}:${member.id}`,
        fromKey: bridgeKey,
        toKey: member.id,
        x1: BRIDGE_W,
        y1: bridgeY + BRIDGE_H / 2,
        x2: center.x,
        y2: center.y,
      });
    }
    // Within-wave dependencies: the only genuinely information-bearing edge.
    // These are ALWAYS forward (a dependency sits in an earlier column by the
    // depth assignment in `dependencyColumns`), so a blocked edge never flows
    // right-to-left and needs no orthogonal back-edge routing. Cross-wave deps
    // are not drawn as edges at all — the spine encodes that ordering.
    for (const member of members) {
      const target = memberCardCenter.get(member.id)!;
      for (const dep of member.blockedBy) {
        if (dep === member.id || !memberIds.has(dep)) continue;
        const source = memberCardCenter.get(dep);
        if (!source) continue;
        edges.push({
          kind: "blocked",
          key: `blocked:${member.id}:${dep}`,
          fromKey: dep,
          toKey: member.id,
          x1: source.x + NODE_W,
          y1: source.y,
          x2: target.x,
          y2: target.y,
        });
      }
    }
    // Review-gate loop edges (review-gates design §10): a member carrying a
    // loop route to a sibling in the same wave gets a reverse return arrow,
    // routed through the reserved channel lane below the gate pair.
    for (const member of members) {
      const source = memberCardCenter.get(member.id)!;
      for (const route of member.routes) {
        if (route.kind !== "loop" || route.to === undefined || route.to === member.id) continue;
        const loopTarget = memberIds.has(route.to) ? memberCardCenter.get(route.to) : undefined;
        if (!loopTarget) continue;
        // Rounded orthogonal loop routed through the channel BELOW the gate pair
        // (mockup's review-loop shape): exit the source's bottom port, run the
        // horizontal channel, rise into the target's bottom port so the arrow
        // lands perpendicular. Endpoints (x1/y1..x2/y2) stay the two ports; the
        // waypoints carry the actual path. Ports sit at distinct offsets so the
        // two vertical drops never overlap.
        const srcBottom = source.y + NODE_H / 2;
        const tgtBottom = loopTarget.y + NODE_H / 2;
        // Route obstacle-aware (channel pushed below every node its span
        // crosses, incl. either endpoint's own nested block; drops in clear
        // lanes) and claim the final channel from the shared registry so loops
        // collapsed onto one Y by a shared obstacle are pulled apart.
        const { points, badge } = routeUnderChannel(
          nodes,
          loopLanes,
          { x: source.x + NODE_W * 0.3, bottom: srcBottom },
          { x: loopTarget.x + NODE_W * 0.55, bottom: tgtBottom },
          LOOP_CHANNEL_DROP,
          LOOP_LANE_STEP,
          new Set([member.id, route.to]),
        );
        edges.push({
          kind: "loop",
          key: `loop:${member.id}:${route.to}`,
          fromKey: member.id,
          toKey: route.to,
          sourceId: member.id,
          points,
          badge,
          x1: points[0]!.x,
          y1: points[0]!.y,
          x2: points[points.length - 1]!.x,
          y2: points[points.length - 1]!.y,
        });
      }
    }

    y += waveH + WAVE_GAP;
  });

  // Cross-wave dependency inversions: a member waiting on a sibling that
  // dispatches in a LATER wave (lower on the spine). A forward cross-wave dep
  // (waiting on an EARLIER wave) is deliberately left undrawn — the spine's
  // top-down order already encodes it. An inversion is the opposite: the spine
  // implies the wrong order, so this is the one cross-wave edge that carries
  // information and must be drawn (it arises when a node is re-gated after
  // spawn, e.g. workstream_set_dependencies pointing an early node at a
  // later-spawned replacement). Routed vertically through a clear side gutter
  // (the long span rules out the below-channel route used for same-wave pairs;
  // the dependency itself sits between the endpoints), deconflicted against the
  // loop/consult lanes via the shared registry.
  let blockH = Math.max(0, y - WAVE_GAP);
  for (const child of children) {
    const target = centreByMember.get(child.id);
    const targetWave = waveIndexByMember.get(child.id);
    if (target === undefined || targetWave === undefined) continue;
    for (const dep of child.blockedBy) {
      if (dep === child.id) continue;
      const source = centreByMember.get(dep);
      const sourceWave = waveIndexByMember.get(dep);
      if (source === undefined || sourceWave === undefined || sourceWave <= targetWave) continue;
      // Ports on the LEFT side of both cards, joined by a vertical run in the
      // nearest gutter left of them that is both obstacle-clear and unclaimed.
      const yTop = Math.min(source.y, target.y);
      const yBot = Math.max(source.y, target.y);
      const laneX = findFreeVerticalLane(
        nodes,
        loopLanes,
        Math.min(source.x, target.x) - LANE_STEP,
        yTop,
        yBot,
        new Set([child.id, dep]),
      );
      loopLanes.claimVertical(laneX, yTop, yBot);
      const points: Point[] = [
        { x: source.x, y: source.y },
        { x: laneX, y: source.y },
        { x: laneX, y: target.y },
        { x: target.x, y: target.y },
      ];
      edges.push({
        kind: "blocked",
        key: `blocked:${child.id}:${dep}`,
        fromKey: dep,
        toKey: child.id,
        points,
        x1: points[0]!.x,
        y1: points[0]!.y,
        x2: points[points.length - 1]!.x,
        y2: points[points.length - 1]!.y,
      });
      for (const p of points) {
        blockW = Math.max(blockW, p.x);
        blockH = Math.max(blockH, p.y);
      }
    }
  }

  // The spine itself is the synthetic join→fork connector between waves.
  for (let i = 1; i < bridgeCenters.length; i += 1) {
    const from = bridgeCenters[i - 1]!;
    const to = bridgeCenters[i]!;
    edges.push({
      kind: "spine",
      key: `spine:${orchestratorId}:${i}`,
      fromKey: `bridge:${orchestratorId}:${i - 1}`,
      toKey: `bridge:${orchestratorId}:${i}`,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    });
  }

  return { nodes, edges, w: blockW, h: blockH };
}

/**
 * A single wave member's sub-block: just its card when it is a leaf, or its card
 * stacked above its own (recursively laid-out) orchestration block when it is a
 * sub-orchestrator. A short solid connector ties the card to its first bridge.
 */
function layoutMember(
  member: SidebarThreadSummary,
  childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<SidebarThreadSummary>>,
  // A gate participant (loop source or target) routes its review loop in the
  // channel just below its card; reserve that lane ABOVE its nested block so the
  // loop can never cut through the member's own spawned descendants.
  reserveLoopLane = false,
): Block {
  const card: LaidNode = {
    kind: "thread",
    key: member.id,
    thread: member,
    x: 0,
    y: 0,
    w: NODE_W,
    h: NODE_H,
  };
  const nested = layoutOrchestrator(member.id, member.title, childrenByParent);
  if (nested.nodes.length === 0) {
    return { nodes: [card], edges: [], w: NODE_W, h: NODE_H };
  }
  const nestVGap = reserveLoopLane ? NEST_VGAP + LOOP_CHANNEL_LANE : NEST_VGAP;
  translate(nested, NEST_INDENT, NODE_H + nestVGap);
  const firstBridge = nested.nodes.find((n) => n.kind === "bridge");
  const edges = [...nested.edges];
  if (firstBridge) {
    edges.push({
      kind: "spine",
      key: `nest:${member.id}`,
      fromKey: member.id,
      toKey: firstBridge.key,
      x1: NODE_W / 2,
      y1: NODE_H,
      x2: firstBridge.x + firstBridge.w / 2,
      y2: firstBridge.y,
    });
  }
  return {
    nodes: [card, ...nested.nodes],
    edges,
    w: Math.max(NODE_W, NEST_INDENT + nested.w),
    h: NODE_H + nestVGap + nested.h,
  };
}

/**
 * Build the whole-orchestration layout from a flat subtree (root + all
 * descendants). The root is the member whose parent is absent from the set.
 */
export function computeForkJoinLayout(threads: ReadonlyArray<SidebarThreadSummary>): {
  nodes: ReadonlyArray<LaidNode>;
  edges: ReadonlyArray<LaidEdge>;
} {
  const ids = new Set(threads.map((t) => t.id));
  const root = threads.find((t) => !t.parentThreadId || !ids.has(t.parentThreadId)) ?? threads[0];
  if (!root) return { nodes: [], edges: [] };
  const childrenByParent = new Map<ThreadId, SidebarThreadSummary[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const siblings = childrenByParent.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else childrenByParent.set(thread.parentThreadId, [thread]);
  }
  return layoutOrchestrator(root.id, root.title, childrenByParent);
}

// ---------------------------------------------------------------------------
// consult_thread observability: cross-edges + out-of-tree annotations derived
// from thread shells' consult summaries. Kept OUT of the memoised structural
// layout (consults change at runtime and are additive) and resolved live from
// the laid-out node positions — the same live-overlay pattern the renderer uses
// for loop-edge rounds.
// ---------------------------------------------------------------------------

/** A directed asker→target consult edge whose endpoints are both in the graph. */
export interface ConsultEdge {
  readonly key: string;
  readonly askerId: ThreadId;
  readonly targetThreadId: ThreadId;
  /** Latest consult timestamp — the anchor for a click-through into the asker's chat. */
  readonly anchorAtIso: string;
  readonly count: number;
  readonly preview: string;
  /** Orthogonal waypoints for a BACKWARD consult (target left of / above the
   * asker): routed through a clear gutter so it never slices a node. Absent for
   * forward consults, which keep the smooth left→right spline. */
  points?: ReadonlyArray<Point>;
  /** Count-badge anchor on the straight routed segment (never a corner). Absent
   * for forward consults, where the renderer uses the endpoint midpoint. */
  badge?: Point;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Aggregate of an asker's consults to targets NOT present in this graph. */
export interface ExternalConsult {
  readonly count: number;
  readonly targetTitles: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Obstacle-aware back-edge routing (loops + backward consults). A back-edge
// exits a bottom port, runs a horizontal channel BELOW every node its span
// crosses, and rises into the target's bottom port. Vertical drops use the
// nearest CLEAR lane (the port's own x when nothing sits below it — the common
// shallow case — else a jog into a clear gutter), so no segment ever crosses a
// node body on a dense or nested graph.
// ---------------------------------------------------------------------------

// A vertical segment at `x` spanning [yTop, yBot] is clear when no node
// rectangle straddles it.
function laneClear(
  nodes: ReadonlyArray<LaidNode>,
  x: number,
  yTop: number,
  yBot: number,
  ignore?: ReadonlySet<string>,
): boolean {
  const lo = Math.min(yTop, yBot);
  const hi = Math.max(yTop, yBot);
  return !nodes.some(
    (n) =>
      !(ignore?.has(n.key) ?? false) &&
      n.x + 1 < x &&
      n.x + n.w - 1 > x &&
      n.y < hi &&
      n.y + n.h > lo,
  );
}

// The nearest clear vertical lane to `startX` for a drop over [yTop, yBot]:
// the port's own x when clear (a straight, shallow drop), otherwise the closest
// clear x searching outward on both sides.
function findNearestClearLane(
  nodes: ReadonlyArray<LaidNode>,
  startX: number,
  yTop: number,
  yBot: number,
  ignore?: ReadonlySet<string>,
): number {
  if (laneClear(nodes, startX, yTop, yBot, ignore)) return startX;
  for (let i = 1; i < 80; i += 1) {
    const left = startX - i * LANE_STEP;
    if (laneClear(nodes, left, yTop, yBot, ignore)) return left;
    const right = startX + i * LANE_STEP;
    if (laneClear(nodes, right, yTop, yBot, ignore)) return right;
  }
  return startX - 80 * LANE_STEP;
}

// The lowest clear Y for a horizontal run spanning [xLo, xHi]: pushed below
// every node whose x-range overlaps the span, so the run crosses no card.
function clearChannelBelow(
  nodes: ReadonlyArray<LaidNode>,
  xLo: number,
  xHi: number,
  preferredY: number,
): number {
  let y = preferredY;
  for (let guard = 0; guard < 200; guard += 1) {
    let pushed = false;
    for (const n of nodes) {
      if (n.x < xHi && n.x + n.w > xLo && n.y < y && n.y + n.h + CHANNEL_MARGIN > y) {
        y = n.y + n.h + CHANNEL_MARGIN;
        pushed = true;
      }
    }
    if (!pushed) break;
  }
  return y;
}

/**
 * Post-clearance lane registry shared by EVERY back-edge (loops + consults,
 * horizontal channels + vertical gutters). A back-edge first clears obstacles,
 * then claims its FINAL routed lane here; a claim that would coincide with an
 * already-taken lane (overlapping perpendicular span, within one step) is bumped
 * to the next free slot. This deconflicts routes that obstacle-pushing collapsed
 * onto the same coordinate — which per-branch counters keyed on the PRELIMINARY
 * band cannot catch.
 */
export class BackEdgeLanes {
  private readonly horizontal: Array<{ coord: number; lo: number; hi: number }> = [];
  private readonly vertical: Array<{ coord: number; lo: number; hi: number }> = [];

  private static taken(
    claimed: ReadonlyArray<{ coord: number; lo: number; hi: number }>,
    coord: number,
    lo: number,
    hi: number,
    step: number,
  ): boolean {
    return claimed.some((l) => Math.abs(l.coord - coord) < step - 0.5 && l.hi > lo && l.lo < hi);
  }

  /** Claim a horizontal channel at/below `y` spanning [lo,hi]; bump DOWN past
   * any overlapping claim (staying clear, since obstacles are above). */
  claimHorizontal(y: number, lo: number, hi: number, step: number): number {
    let coord = y;
    while (BackEdgeLanes.taken(this.horizontal, coord, lo, hi, step)) coord += step;
    this.horizontal.push({ coord, lo, hi });
    return coord;
  }

  /** Record a horizontal channel without bumping (seed pre-existing routes). */
  reserveHorizontal(y: number, lo: number, hi: number): void {
    this.horizontal.push({ coord: y, lo, hi });
  }

  /** Whether a vertical lane at `x` spanning [lo,hi] is unclaimed. */
  verticalFree(x: number, lo: number, hi: number, step: number): boolean {
    return !BackEdgeLanes.taken(this.vertical, x, lo, hi, step);
  }

  claimVertical(x: number, lo: number, hi: number): void {
    this.vertical.push({ coord: x, lo, hi });
  }
}

// The nearest vertical lane to `startX` over [yTop,yBot] that is BOTH obstacle-
// clear and unclaimed in the registry — so two same-column back-edges never pick
// the same gutter. Searches outward, bounded.
function findFreeVerticalLane(
  nodes: ReadonlyArray<LaidNode>,
  lanes: BackEdgeLanes,
  startX: number,
  yTop: number,
  yBot: number,
  ignore: ReadonlySet<string>,
): number {
  const ok = (x: number) =>
    laneClear(nodes, x, yTop, yBot, ignore) && lanes.verticalFree(x, yTop, yBot, LANE_STEP);
  if (ok(startX)) return startX;
  for (let i = 1; i < 80; i += 1) {
    if (ok(startX - i * LANE_STEP)) return startX - i * LANE_STEP;
    if (ok(startX + i * LANE_STEP)) return startX + i * LANE_STEP;
  }
  return startX - 80 * LANE_STEP;
}

// Route a back-edge from one bottom port to another through a clear channel
// below all obstacles, with clear-lane drops. The FINAL channel Y is claimed
// from the shared lane registry so obstacle-collapsed routes stay distinct.
// `ignore` excludes the two endpoint cards from lane checks (a port legitimately
// sits on its own card).
function routeUnderChannel(
  nodes: ReadonlyArray<LaidNode>,
  lanes: BackEdgeLanes,
  from: { x: number; bottom: number },
  to: { x: number; bottom: number },
  drop: number,
  step: number,
  ignore: ReadonlySet<string>,
): { points: Point[]; badge: Point } {
  const prelim = Math.max(from.bottom, to.bottom) + drop;
  const spanLo = Math.min(from.x, to.x);
  const spanHi = Math.max(from.x, to.x);
  // Clear obstacles, THEN claim the final lane (deconflicts collapsed routes).
  const channelY = lanes.claimHorizontal(
    clearChannelBelow(nodes, spanLo, spanHi, prelim),
    spanLo,
    spanHi,
    step,
  );
  const fromX = findNearestClearLane(nodes, from.x, from.bottom, channelY, ignore);
  const toX = findNearestClearLane(nodes, to.x, to.bottom, channelY, ignore);
  lanes.claimVertical(fromX, from.bottom, channelY);
  lanes.claimVertical(toX, to.bottom, channelY);
  const points: Point[] = [{ x: from.x, y: from.bottom }];
  if (fromX !== from.x) points.push({ x: fromX, y: from.bottom });
  points.push({ x: fromX, y: channelY }, { x: toX, y: channelY });
  if (toX !== to.x) points.push({ x: toX, y: to.bottom });
  points.push({ x: to.x, y: to.bottom });
  return { points, badge: { x: (fromX + toX) / 2, y: channelY } };
}

/**
 * Consults are global — a target may live outside this workstream's graph. For
 * in-graph targets draw a directed edge (entering the target's near side); for
 * out-of-tree targets return a per-asker annotation instead of inventing a
 * phantom node.
 */
export function deriveConsultOverlay(
  nodes: ReadonlyArray<LaidNode>,
  threadById: ReadonlyMap<ThreadId, SidebarThreadSummary>,
  laidEdges: ReadonlyArray<LaidEdge> = [],
): { edges: ConsultEdge[]; externalByAskerId: Map<ThreadId, ExternalConsult> } {
  const centerById = new Map<ThreadId, Extract<LaidNode, { kind: "thread" }>>();
  for (const node of nodes) {
    if (node.kind === "thread") centerById.set(node.thread.id, node);
  }
  const edges: ConsultEdge[] = [];
  const externalByAskerId = new Map<ThreadId, ExternalConsult>();
  // ONE post-clearance lane registry for every back-edge on the graph. Seed it
  // with the already-routed structural loops so a consult never lands on a
  // loop's channel or gutter, then let each consult claim its own lane.
  const lanes = new BackEdgeLanes();
  for (const edge of laidEdges) {
    if (edge.kind !== "loop" || !edge.points) continue;
    for (let i = 0; i < edge.points.length - 1; i += 1) {
      const a = edge.points[i]!;
      const b = edge.points[i + 1]!;
      if (Math.abs(a.y - b.y) < 0.5) {
        lanes.reserveHorizontal(a.y, Math.min(a.x, b.x), Math.max(a.x, b.x));
      } else {
        lanes.claimVertical(a.x, Math.min(a.y, b.y), Math.max(a.y, b.y));
      }
    }
  }
  for (const node of nodes) {
    if (node.kind !== "thread") continue;
    const asker = threadById.get(node.thread.id) ?? node.thread;
    for (const consult of asker.consults) {
      if (consult.targetThreadId === asker.id) continue;
      const target = centerById.get(consult.targetThreadId);
      if (target) {
        const base = {
          key: `consult:${asker.id}:${consult.targetThreadId}`,
          askerId: asker.id,
          targetThreadId: consult.targetThreadId,
          anchorAtIso: consult.lastConsultAt,
          count: consult.count,
          preview: consult.lastQuestionPreview,
        } as const;
        const aMidY = node.y + node.h / 2;
        const tMidY = target.y + target.h / 2;
        // Strictly to the right (a clear column gutter between them): the smooth
        // forward spline. Everything else is a back-edge routed ONLY through
        // gutters that are verified clear of EVERY node (not just the two
        // endpoints), so it can never slice a card on a dense/nested graph.
        const strictlyRight = target.x >= node.x + node.w;
        const sameColumn = Math.abs(target.x - node.x) < NODE_W;
        if (strictlyRight) {
          edges.push({
            ...base,
            x1: node.x + node.w,
            y1: aMidY,
            x2: target.x,
            y2: tMidY,
          });
        } else if (sameColumn) {
          // Same column (target above/below): a vertical run in the nearest lane
          // beside the column that is BOTH obstacle-clear and unclaimed, so two
          // same-column consults can never pick the identical gutter.
          const ignore = new Set([node.key, target.key]);
          const yTop = Math.min(aMidY, tMidY);
          const yBot = Math.max(aMidY, tMidY);
          const laneX = findFreeVerticalLane(
            nodes,
            lanes,
            Math.min(node.x, target.x) - LANE_STEP,
            yTop,
            yBot,
            ignore,
          );
          lanes.claimVertical(laneX, yTop, yBot);
          const askerPort = { x: node.x, y: aMidY };
          const targetPort = { x: target.x, y: tMidY };
          edges.push({
            ...base,
            points: [askerPort, { x: laneX, y: aMidY }, { x: laneX, y: tMidY }, targetPort],
            badge: { x: laneX, y: (aMidY + tMidY) / 2 },
            x1: askerPort.x,
            y1: askerPort.y,
            x2: targetPort.x,
            y2: targetPort.y,
          });
        } else {
          // Target to the left in another column: an obstacle-aware staple whose
          // channel is claimed from the shared registry (deconflicted against
          // loops and other consults), with clear-lane drops on the bottom ports.
          const { points, badge } = routeUnderChannel(
            nodes,
            lanes,
            { x: node.x + node.w * 0.45, bottom: node.y + node.h },
            { x: target.x + target.w * 0.55, bottom: target.y + target.h },
            LOOP_CHANNEL_DROP,
            CONSULT_LANE_STEP,
            new Set([node.key, target.key]),
          );
          edges.push({
            ...base,
            points,
            badge,
            x1: points[0]!.x,
            y1: points[0]!.y,
            x2: points[points.length - 1]!.x,
            y2: points[points.length - 1]!.y,
          });
        }
      } else {
        const prior = externalByAskerId.get(asker.id);
        externalByAskerId.set(asker.id, {
          count: (prior?.count ?? 0) + consult.count,
          targetTitles: [...(prior?.targetTitles ?? []), consult.targetTitle],
        });
      }
    }
  }
  return { edges, externalByAskerId };
}

/** Every point a set of edges paints — endpoints, routed waypoints, and badge
 * anchors — so the viewBox can bound routed back-edges (loops/consults) that
 * dip below the node band instead of clipping them. */
function edgeExtentPoints(
  edges: ReadonlyArray<{
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly points?: ReadonlyArray<Point>;
    readonly badge?: Point;
  }>,
): Point[] {
  const pts: Point[] = [];
  for (const edge of edges) {
    if (edge.points) pts.push(...edge.points);
    else pts.push({ x: edge.x1, y: edge.y1 }, { x: edge.x2, y: edge.y2 });
    if (edge.badge)
      pts.push(
        { x: edge.badge.x - 20, y: edge.badge.y },
        { x: edge.badge.x + 20, y: edge.badge.y },
      );
  }
  return pts;
}

/**
 * Content bounds for the graph. Includes node rectangles AND all routed edge
 * geometry (loop channels, backward-consult channels, count badges) so a
 * back-edge that dips into the gutter below the last row is never clipped out of
 * the SVG, and its click hit-target stays reachable. `extraEdges` carries the
 * live consult overlay, which is not part of the memoised structural layout.
 */
export function computeForkJoinViewBox(
  nodes: ReadonlyArray<LaidNode>,
  edges: ReadonlyArray<LaidEdge> = [],
  extraEdges: ReadonlyArray<ConsultEdge> = [],
): ViewBox {
  const pad = 32;
  if (nodes.length === 0) return { x: 0, y: 0, w: 320, h: 240 };
  const xs = [...nodes.map((n) => n.x), ...nodes.map((n) => n.x + n.w)];
  const ys = [...nodes.map((n) => n.y), ...nodes.map((n) => n.y + n.h)];
  for (const p of [...edgeExtentPoints(edges), ...edgeExtentPoints(extraEdges)]) {
    xs.push(p.x);
    ys.push(p.y);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}
