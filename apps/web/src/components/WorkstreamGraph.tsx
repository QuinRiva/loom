// Workstream lineage graph — a deliberately READ-ONLY topology view. Position
// encodes lineage + dependency order (computed by d3-dag's layered Sugiyama
// layout); status is conveyed by colour only. We own the SVG renderer and a
// zero-dependency pan/zoom, and add only the missing concern (layout).
//
// If this view ever becomes an EDITABLE orchestration canvas (drag nodes to
// rewire, minimap, multi-select), the correct move is to refactor to React Flow
// — not to extend this SVG. See docs/research/workstream-dag-visualization.md
// (§"Future direction") for the full rationale and the decision boundary.

import { coordGreedy, type GraphNode, graph, layeringLongestPath, sugiyama } from "d3-dag";
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
import type { SidebarThreadSummary, Thread } from "../types";

// Sentinel id for the orchestrator (parent) node, which has no SidebarThreadSummary.
const ROOT_ID = "__workstream_root__";

const ROOT_SIZE = [160, 48] as const;
const NODE_SIZE = [126, 54] as const;

type Point = { readonly x: number; readonly y: number };
type ViewBox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Lay out the orchestrator + every sub-thread with d3-dag's layered Sugiyama
 * algorithm. Lineage edges (parent→child) and `waits-on` edges both feed the
 * ranking so dependents sit below their dependencies — except `waits-on` edges
 * that would introduce a cycle, which sugiyama cannot lay out. We add each such
 * edge, then back it out if `g.acyclic()` flips false (self-edges are skipped
 * outright). Returns node *centres* keyed by id (ROOT_ID for the orchestrator).
 *
 * Operator choice: the default `layeringSimplex` + `coordSimplex` pull in an LP
 * solver (`javascript-lp-solver` + `quadprog`, ~142 KB). At <100 nodes the
 * lighter `layeringLongestPath` + `coordGreedy` (with the default solver-free
 * `decrossTwoLayer`) produce a clean layout without that weight.
 */
function computeLayout(threads: ReadonlyArray<SidebarThreadSummary>): Map<string, Point> {
  const g = graph<{ id: string }, undefined>();
  const rootNode = g.node({ id: ROOT_ID });
  const nodeById = new Map(threads.map((thread) => [thread.id, g.node({ id: thread.id })]));

  for (const thread of threads) {
    const parent = (thread.parentThreadId && nodeById.get(thread.parentThreadId)) || rootNode;
    g.link(parent, nodeById.get(thread.id)!);
  }

  for (const thread of threads) {
    const target = nodeById.get(thread.id)!;
    for (const depId of thread.blockedBy) {
      const source = depId === thread.id ? undefined : nodeById.get(depId);
      if (!source) continue;
      const link = g.link(source, target);
      if (!g.acyclic()) link.delete();
    }
  }

  sugiyama()
    // d3-dag infers operator data as `never` unless the accessor is typed.
    .nodeSize((node: GraphNode<{ id: string }, undefined>) =>
      node.data.id === ROOT_ID ? ROOT_SIZE : NODE_SIZE,
    )
    .gap([28, 36])
    .layering(layeringLongestPath())
    .coord(coordGreedy())(g);

  return new Map([...g.nodes()].map((node) => [node.data.id, { x: node.x, y: node.y }]));
}

// Node rects span ±63 × ±27 around their centre; the root rect is 160 × 48.
function computeGraphViewBox(positions: ReadonlyArray<Point>, root: Point): ViewBox {
  const pad = 28;
  const xs = [root.x - 80, root.x + 80, ...positions.flatMap((p) => [p.x - 63, p.x + 63])];
  const ys = [root.y - 24, root.y + 24, ...positions.flatMap((p) => [p.y - 27, p.y + 27])];
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

export default function WorkstreamGraph({
  activeThread,
  threads,
  childById,
  onOpenThread,
}: {
  readonly activeThread: Thread;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly childById: ChildIndex;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
}) {
  // Layout depends only on topology (ids + parent + blockedBy), not on status,
  // so memoise on a structural key to avoid re-running Sugiyama every render.
  const topologyKey = threads
    .map((t) => `${t.id}>${t.parentThreadId ?? ""}:${t.blockedBy.join(",")}`)
    .join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => computeLayout(threads), [topologyKey]);

  const root = layout.get(ROOT_ID) ?? { x: 0, y: 0 };
  const positions = threads.flatMap((thread) => {
    const point = layout.get(thread.id);
    return point ? [{ threadId: thread.id, ...point }] : [];
  });
  const positionById = new Map(positions.map((position) => [position.threadId, position]));
  const parentOf = (thread: SidebarThreadSummary): Point =>
    (thread.parentThreadId && positionById.get(thread.parentThreadId)) || root;

  const base = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => computeGraphViewBox(positions, root),
    [topologyKey],
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; vb: ViewBox } | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox>(base);
  const [adjusted, setAdjusted] = useState(false);

  // Auto-fit until the user pans/zooms; "reset" re-enables auto-fit.
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

  // Wheel zoom anchored at the cursor. Attached non-passively so it can
  // preventDefault and not scroll the surrounding panel.
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
    // zoomBy/base are stable enough for this listener's lifetime per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    // Let node clicks through; only pan when starting on empty canvas.
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
        Lineage edges run orchestrator → sub-thread; dashed amber edges are &ldquo;waits-on&rdquo;
        dependencies. Colour matches board state; click any node to open the thread.
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
          aria-label="Workstream lineage graph"
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
              <path d="M0 0 L6 3 L0 6 z" fill="rgba(255,255,255,0.35)" />
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
          <RootNode x={root.x} y={root.y} title={activeThread.title} />
          {positions.map((position) => {
            const thread = childById.get(position.threadId);
            if (!thread) return null;
            const parent = parentOf(thread);
            return (
              <path
                d={`M ${parent.x} ${parent.y + 24} C ${parent.x} ${(parent.y + position.y) / 2}, ${
                  position.x
                } ${(parent.y + position.y) / 2}, ${position.x} ${position.y - 25}`}
                fill="none"
                key={`edge-${thread.id}`}
                markerEnd="url(#workstream-arrow)"
                stroke="rgba(255,255,255,0.28)"
                strokeWidth="1.4"
              />
            );
          })}
          {positions.flatMap((position) => {
            const thread = childById.get(position.threadId);
            if (!thread) return [];
            return thread.blockedBy.flatMap((depId) => {
              if (depId === thread.id) return [];
              const depPosition = positionById.get(depId);
              if (!depPosition) return [];
              return [
                <line
                  key={`waits-${thread.id}-${depId}`}
                  markerEnd="url(#workstream-waits-arrow)"
                  stroke={WAITS_ON_STROKE}
                  strokeDasharray="4 3"
                  strokeWidth="1.3"
                  x1={depPosition.x}
                  x2={position.x}
                  y1={depPosition.y}
                  y2={position.y}
                />,
              ];
            });
          })}
          {positions.map((position) => {
            const thread = childById.get(position.threadId);
            return thread ? (
              <GraphNode
                key={thread.id}
                thread={thread}
                childById={childById}
                x={position.x}
                y={position.y}
                onOpenThread={onOpenThread}
              />
            ) : null;
          })}
          {threads.length === 0 ? (
            <text
              fill="rgba(255,255,255,0.38)"
              fontSize="13"
              textAnchor="middle"
              x={root.x}
              y={root.y + 42}
            >
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

function RootNode({
  x,
  y,
  title,
}: {
  readonly x: number;
  readonly y: number;
  readonly title: string;
}) {
  return (
    <g>
      <rect
        fill="rgba(255,255,255,0.07)"
        height="48"
        rx="11"
        stroke="rgba(255,255,255,0.18)"
        width="160"
        x={x - 80}
        y={y - 24}
      />
      <text
        fill="rgba(255,255,255,0.82)"
        fontSize="12"
        fontWeight="600"
        textAnchor="middle"
        x={x}
        y={y - 2}
      >
        Orchestrator
      </text>
      <text fill="rgba(255,255,255,0.38)" fontSize="9.5" textAnchor="middle" x={x} y={y + 14}>
        {truncateLabel(title, 24)}
      </text>
    </g>
  );
}

function GraphNode({
  thread,
  childById,
  x,
  y,
  onOpenThread,
}: {
  readonly thread: SidebarThreadSummary;
  readonly childById: ChildIndex;
  readonly x: number;
  readonly y: number;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
}) {
  const status = getThreadStatus(thread, childById);
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
        height="54"
        rx="10"
        stroke={status.graphStroke}
        strokeWidth="1.4"
        width="126"
        x={x - 63}
        y={y - 27}
      />
      <circle cx={x - 48} cy={y - 10} fill={status.graphStroke} r="4" />
      <text fill={status.graphStroke} fontSize="12" x={x - 38} y={y - 6}>
        {getRoleIcon(thread)}
      </text>
      <text fill="rgba(255,255,255,0.9)" fontSize="11" fontWeight="600" x={x - 20} y={y - 6}>
        {truncateLabel(thread.title, 16)}
      </text>
      <text
        fill="rgba(255,255,255,0.45)"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="8.5"
        x={x - 49}
        y={y + 11}
      >
        {truncateLabel(getRoleLabel(thread), 12)} · {status.label}
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
