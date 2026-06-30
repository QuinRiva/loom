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
export const NODE_W = 146;
export const NODE_H = 56;
const FORK_GAP = 54; // bridge right edge → first child column
const COL_GAP = 50; // between dependency columns (room for blockedBy arrows)
const ROW_GAP = 18; // between stacked members in a column
const WAVE_GAP = 38; // between consecutive waves down the spine
const NEST_INDENT = 26; // a sub-orchestrator's nested block, indented under its card
const NEST_VGAP = 18; // card → its nested block

export type Point = { readonly x: number; readonly y: number };
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

export type EdgeKind = "spine" | "fork" | "blocked";
export interface LaidEdge {
  readonly kind: EdgeKind;
  readonly key: string;
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
  let y = 0;
  let blockW = BRIDGE_W;

  waveOrder.forEach((waveMembers, waveIndex) => {
    const members = [...waveMembers].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const subBlockByMember = new Map<ThreadId, Block>(
      members.map((m) => [m.id, layoutMember(m, childrenByParent)]),
    );
    const columns = dependencyColumns(members);
    const colLayouts = columns.map((column) => {
      const blocks = column.map((m) => subBlockByMember.get(m.id)!);
      const colW = blocks.reduce((max, b) => Math.max(max, b.w), NODE_W);
      const colH = blocks.reduce((sum, b) => sum + b.h, 0) + ROW_GAP * (column.length - 1);
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
        cy += cl.blocks[rowIndex]!.h + ROW_GAP;
      });
      cx += cl.colW + COL_GAP;
    }
    blockW = Math.max(blockW, cx - COL_GAP);

    nodes.push({
      kind: "bridge",
      key: `bridge:${orchestratorId}:${waveIndex}`,
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
        x1: BRIDGE_W,
        y1: bridgeY + BRIDGE_H / 2,
        x2: center.x,
        y2: center.y,
      });
    }
    // Within-wave dependencies: the only genuinely information-bearing edge.
    const memberIds = new Set(members.map((m) => m.id));
    for (const member of members) {
      const target = memberCardCenter.get(member.id)!;
      for (const dep of member.blockedBy) {
        if (dep === member.id || !memberIds.has(dep)) continue;
        const source = memberCardCenter.get(dep);
        if (!source) continue;
        edges.push({
          kind: "blocked",
          key: `blocked:${member.id}:${dep}`,
          x1: source.x + NODE_W,
          y1: source.y,
          x2: target.x,
          y2: target.y,
        });
      }
    }

    y += waveH + WAVE_GAP;
  });

  // The spine itself is the synthetic join→fork connector between waves.
  for (let i = 1; i < bridgeCenters.length; i += 1) {
    const from = bridgeCenters[i - 1]!;
    const to = bridgeCenters[i]!;
    edges.push({
      kind: "spine",
      key: `spine:${orchestratorId}:${i}`,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    });
  }

  return { nodes, edges, w: blockW, h: Math.max(0, y - WAVE_GAP) };
}

/**
 * A single wave member's sub-block: just its card when it is a leaf, or its card
 * stacked above its own (recursively laid-out) orchestration block when it is a
 * sub-orchestrator. A short solid connector ties the card to its first bridge.
 */
function layoutMember(
  member: SidebarThreadSummary,
  childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<SidebarThreadSummary>>,
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
  translate(nested, NEST_INDENT, NODE_H + NEST_VGAP);
  const firstBridge = nested.nodes.find((n) => n.kind === "bridge");
  const edges = [...nested.edges];
  if (firstBridge) {
    edges.push({
      kind: "spine",
      key: `nest:${member.id}`,
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
    h: NODE_H + NEST_VGAP + nested.h,
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

export function computeForkJoinViewBox(nodes: ReadonlyArray<LaidNode>): ViewBox {
  const pad = 32;
  if (nodes.length === 0) return { x: 0, y: 0, w: 320, h: 240 };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}
