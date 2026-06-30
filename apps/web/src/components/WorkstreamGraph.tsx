// Workstream fork–join graph — a deliberately READ-ONLY "dispatch episode" view.
// The orchestrator is not a single root: it recurs as one BRIDGE node per wave,
// where a wave = the children of one (parentThreadId, spawnGeneration) — the set
// the engine spawns before it next regains control. Waves stack down a neutral
// solid spine ordered by each wave's earliest child; within a wave, children sit
// in dependency columns and real `blockedBy` edges are dashed-amber cross-edges.
// Nesting (a child that itself spawns) is the same layout applied recursively and
// packed as a measured block. Position encodes temporal/causal dispatch order;
// status is colour only. Hand-rolled band layout + zero-dependency pan/zoom.
//
// If this ever becomes an EDITABLE orchestration canvas (drag to rewire, minimap),
// refactor to React Flow — see docs/research/workstream-dag-visualization.md.

import type { ThreadId } from "@t3tools/contracts";
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  computeForkJoinLayout,
  computeForkJoinViewBox,
  type LaidEdge,
  type LaidNode,
  type ViewBox,
} from "../lib/forkJoinLayout";
import {
  type ChildIndex,
  COLUMN_LABELS,
  COLUMN_ORDER,
  getPurpose,
  getRoleIcon,
  getRoleLabel,
  getThreadStatus,
  STATUS_STYLES,
  truncateLabel,
  WAITS_ON_STROKE,
} from "../lib/workstreamPresentation";
import type { SidebarThreadSummary } from "../types";

const SPINE_STROKE = "rgba(255,255,255,0.30)";
const FORK_STROKE = "rgba(255,255,255,0.26)";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function WorkstreamGraph({
  threads,
  threadById,
  onOpenThread,
  onOpenDispatch,
}: {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly threadById: ChildIndex;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
  readonly onOpenDispatch: (orchestratorId: ThreadId, anchorAtIso: string) => void;
}) {
  // Layout depends only on structure (lineage + generation + deps + order), so
  // memoise on a structural key rather than re-running on every status tick.
  const structureKey = threads
    .map(
      (t) =>
        `${t.id}>${t.parentThreadId ?? ""}@${t.spawnGeneration ?? ""}#${t.createdAt}:${t.blockedBy.join(",")}`,
    )
    .join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { nodes, edges } = useMemo(() => computeForkJoinLayout(threads), [structureKey]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => computeForkJoinViewBox(nodes), [structureKey]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; vb: ViewBox } | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox>(base);
  const [adjusted, setAdjusted] = useState(false);

  useEffect(() => {
    if (!adjusted) setViewBox(base);
  }, [base, adjusted]);

  const zoomBy = (factor: number, anchorX = 0.5, anchorY = 0.5) => {
    setAdjusted(true);
    setViewBox((vb) => {
      const w = clamp(vb.w * factor, base.w * 0.25, base.w * 4);
      const h = w * (vb.h / vb.w);
      return { x: vb.x + (vb.w - w) * anchorX, y: vb.y + (vb.h - h) * anchorY, w, h };
    });
  };

  const resetView = () => {
    setAdjusted(false);
    setViewBox(base);
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomBy(
        event.deltaY < 0 ? 0.88 : 1 / 0.88,
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height,
      );
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest(".ws-graph-node")) return;
    dragRef.current = { x: event.clientX, y: event.clientY, vb: viewBox };
    setAdjusted(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setViewBox({
      ...drag.vb,
      x: drag.vb.x - (event.clientX - drag.x) * (drag.vb.w / rect.width),
      y: drag.vb.y - (event.clientY - drag.y) * (drag.vb.h / rect.height),
    });
  };
  const endPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="px-2 text-center text-[11px] leading-relaxed text-white/35">
        The orchestrator recurs as a bridge node per dispatch wave down the solid spine; children of
        a wave sit to its right, with dashed amber &ldquo;waits-on&rdquo; cross-edges. Click a
        bridge to jump to where that wave was dispatched; click a node to open the thread.
      </p>
      <div className="relative w-full">
        <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
          <GraphControlButton label="Zoom in" onClick={() => zoomBy(0.8)}>
            <ZoomInIcon className="size-3.5" />
          </GraphControlButton>
          <GraphControlButton label="Zoom out" onClick={() => zoomBy(1.25)}>
            <ZoomOutIcon className="size-3.5" />
          </GraphControlButton>
          <GraphControlButton label="Reset view" onClick={resetView}>
            <MaximizeIcon className="size-3.5" />
          </GraphControlButton>
        </div>
        <svg
          ref={svgRef}
          className="min-h-[240px] w-full touch-none cursor-grab rounded-xl border border-white/10 bg-black/20 active:cursor-grabbing"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          role="img"
          aria-label="Workstream fork–join graph"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <defs>
            <marker
              id="workstream-arrow"
              markerHeight="8"
              markerWidth="8"
              orient="auto"
              refX="6"
              refY="3"
            >
              <path d="M0 0 L6 3 L0 6 z" fill={FORK_STROKE} />
            </marker>
            <marker
              id="workstream-waits-arrow"
              markerHeight="8"
              markerWidth="8"
              orient="auto"
              refX="6"
              refY="3"
            >
              <path d="M0 0 L6 3 L0 6 z" fill={WAITS_ON_STROKE} />
            </marker>
          </defs>
          {edges.map((edge) => (
            <GraphEdge key={edge.key} edge={edge} />
          ))}
          {nodes.map((node) =>
            node.kind === "bridge" ? (
              <BridgeNode key={node.key} node={node} onOpenDispatch={onOpenDispatch} />
            ) : (
              <GraphNode
                key={node.key}
                node={node}
                threadById={threadById}
                onOpenThread={onOpenThread}
              />
            ),
          )}
          {nodes.length === 0 ? (
            <text fill="rgba(255,255,255,0.38)" fontSize="13" textAnchor="middle" x={160} y={120}>
              No sub-threads yet.
            </text>
          ) : null}
        </svg>
      </div>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 px-2 pb-1">
        {COLUMN_ORDER.map((column) => (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-white/45" key={column}>
            <span className={`size-2 rounded-full ${STATUS_STYLES[column].dotClass}`} />
            {COLUMN_LABELS[column]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/45">
          <span className="inline-block h-0 w-4 border-t" style={{ borderColor: SPINE_STROKE }} />
          dispatch spine
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/45">
          <span
            className="inline-block h-0 w-4 border-t border-dashed"
            style={{ borderColor: WAITS_ON_STROKE }}
          />
          waits-on
        </span>
      </div>
    </div>
  );
}

function GraphEdge({ edge }: { readonly edge: LaidEdge }) {
  if (edge.kind === "spine") {
    return (
      <line
        stroke={SPINE_STROKE}
        strokeWidth="2"
        x1={edge.x1}
        x2={edge.x2}
        y1={edge.y1}
        y2={edge.y2}
      />
    );
  }
  if (edge.kind === "fork") {
    const midX = (edge.x1 + edge.x2) / 2;
    return (
      <path
        d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`}
        fill="none"
        markerEnd="url(#workstream-arrow)"
        stroke={FORK_STROKE}
        strokeWidth="1.4"
      />
    );
  }
  const midX = (edge.x1 + edge.x2) / 2;
  return (
    <path
      d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`}
      fill="none"
      markerEnd="url(#workstream-waits-arrow)"
      stroke={WAITS_ON_STROKE}
      strokeDasharray="4 3"
      strokeWidth="1.3"
    />
  );
}

function BridgeNode({
  node,
  onOpenDispatch,
}: {
  readonly node: Extract<LaidNode, { kind: "bridge" }>;
  readonly onOpenDispatch: (orchestratorId: ThreadId, anchorAtIso: string) => void;
}) {
  const open = () => onOpenDispatch(node.orchestratorId, node.anchorAtIso);
  return (
    <g
      className="ws-graph-node cursor-pointer outline-none"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <title>{`Jump to where wave ${node.waveIndex} was dispatched`}</title>
      <rect
        fill="rgba(255,255,255,0.07)"
        height={node.h}
        rx="11"
        stroke="rgba(255,255,255,0.18)"
        width={node.w}
        x={node.x}
        y={node.y}
      />
      <text
        fill="rgba(255,255,255,0.82)"
        fontSize="12"
        fontWeight="600"
        textAnchor="middle"
        x={node.x + node.w / 2}
        y={node.y + 19}
      >
        {truncateLabel(node.label, 22)}
      </text>
      <text
        fill="rgba(255,255,255,0.4)"
        fontSize="9.5"
        textAnchor="middle"
        x={node.x + node.w / 2}
        y={node.y + 34}
      >
        Orchestrator · wave {node.waveIndex}
      </text>
    </g>
  );
}

function GraphNode({
  node,
  threadById,
  onOpenThread,
}: {
  readonly node: Extract<LaidNode, { kind: "thread" }>;
  readonly threadById: ChildIndex;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
}) {
  // The laid-out node carries a STRUCTURAL snapshot (layout is memoised on a key
  // that excludes status), so resolve the live summary for status/labels — else
  // a lane/attention change wouldn't recolour the node until the graph re-lays.
  const thread = threadById.get(node.thread.id) ?? node.thread;
  const status = getThreadStatus(thread, threadById);
  const open = () => onOpenThread(thread);
  return (
    <g
      className="ws-graph-node cursor-pointer outline-none"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <title>{`Goal: ${getPurpose(thread)}`}</title>
      <rect
        fill={status.graphFill}
        height={node.h}
        rx="10"
        stroke={status.graphStroke}
        strokeWidth="1.4"
        width={node.w}
        x={node.x}
        y={node.y}
      />
      <circle cx={node.x + 15} cy={node.y + 17} fill={status.graphStroke} r="4" />
      <text fill={status.graphStroke} fontSize="12" x={node.x + 25} y={node.y + 21}>
        {getRoleIcon(thread)}
      </text>
      <text
        fill="rgba(255,255,255,0.9)"
        fontSize="11"
        fontWeight="600"
        x={node.x + 43}
        y={node.y + 21}
      >
        {truncateLabel(thread.title, 14)}
      </text>
      <text
        fill="rgba(255,255,255,0.45)"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="8.5"
        x={node.x + 14}
        y={node.y + 39}
      >
        {truncateLabel(getRoleLabel(thread), 13)} · {status.label}
      </text>
    </g>
  );
}

function GraphControlButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md border border-white/10 bg-black/40 p-1.5 text-white/55 backdrop-blur transition hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
