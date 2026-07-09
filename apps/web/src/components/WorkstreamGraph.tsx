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
  deriveConsultOverlay,
  type ConsultEdge,
  type ExternalConsult,
  type LaidEdge,
  type LaidNode,
  type ViewBox,
} from "../lib/forkJoinLayout";
import {
  type ChildIndex,
  COLUMN_LABELS,
  COLUMN_ORDER,
  getGateLoopCap,
  getGateWaitLabel,
  getLoopStroke,
  getPurpose,
  getRoleIcon,
  getRoleLabel,
  getThreadStatus,
  getVerdictChip,
  CONSULT_STROKE,
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
  readonly onOpenDispatch: (
    threadId: ThreadId,
    anchorAtIso: string,
    expandConsultTargetId?: ThreadId,
  ) => void;
}) {
  // Layout depends only on structure (lineage + generation + deps + loop routes
  // + order), so memoise on a structural key rather than re-running on every
  // status tick. Loop ROUNDS are live-resolved at render, not part of the key.
  const structureKey = threads
    .map(
      (t) =>
        `${t.id}>${t.parentThreadId ?? ""}@${t.spawnGeneration ?? ""}#${t.createdAt}:${t.blockedBy.join(",")}~${t.routes
          .filter((route) => route.kind === "loop")
          .map((route) => route.to ?? "")
          .join(",")}`,
    )
    .join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { nodes, edges } = useMemo(() => computeForkJoinLayout(threads), [structureKey]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => computeForkJoinViewBox(nodes), [structureKey]);

  // Consult overlay is derived live (not part of the memoised structural layout)
  // so newly-recorded consults appear without a re-layout — mirroring how loop
  // rounds are resolved at render time.
  const consultOverlay = useMemo(
    () => deriveConsultOverlay(nodes, threadById),
    [nodes, threadById],
  );

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
    if ((event.target as Element).closest(".ws-graph-node, .ws-graph-consult-edge")) return;
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
            <marker
              id="workstream-loop-arrow"
              markerHeight="8"
              markerWidth="8"
              orient="auto"
              refX="6"
              refY="3"
            >
              <path d="M0 0 L6 3 L0 6 z" fill={getLoopStroke(1)} />
            </marker>
            <marker
              id="workstream-consult-arrow"
              markerHeight="8"
              markerWidth="8"
              orient="auto"
              refX="6"
              refY="3"
            >
              <path d="M0 0 L6 3 L0 6 z" fill={CONSULT_STROKE} />
            </marker>
          </defs>
          {edges.map((edge) => (
            <GraphEdge key={edge.key} edge={edge} threadById={threadById} />
          ))}
          {consultOverlay.edges.map((edge) => (
            <ConsultGraphEdge key={edge.key} edge={edge} onOpenDispatch={onOpenDispatch} />
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
                externalConsult={consultOverlay.externalByAskerId.get(node.thread.id)}
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
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/45">
          <span
            className="inline-block h-0 w-4 border-t"
            style={{ borderColor: getLoopStroke(1) }}
          />
          review loop ⟲
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/45">
          <span
            className="inline-block h-0 w-4 border-t border-dotted"
            style={{ borderColor: CONSULT_STROKE }}
          />
          consult
        </span>
      </div>
    </div>
  );
}

function GraphEdge({
  edge,
  threadById,
}: {
  readonly edge: LaidEdge;
  readonly threadById: ChildIndex;
}) {
  if (edge.kind === "loop") {
    // Return arrow of a review gate: reverse-direction, bowed BELOW the cards so
    // it reads as a cycle against the forward waits-on edge. Stroke darkens with
    // consumed rework rounds; the midpoint badge shows rounds vs cap. Rounds are
    // resolved live from the gate source so the edge recolours without re-layout.
    const source = edge.sourceId ? threadById.get(edge.sourceId) : undefined;
    const rounds = source?.gateRounds ?? 0;
    const cap = source ? getGateLoopCap(source) : rounds;
    const stroke = getLoopStroke(rounds);
    const midX = (edge.x1 + edge.x2) / 2;
    const drop = 30;
    // Cubic midpoint with both control points at +drop: avg(y) + 0.75 * drop.
    const badgeY = (edge.y1 + edge.y2) / 2 + drop * 0.75;
    return (
      <g>
        <path
          d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1 + drop}, ${midX} ${edge.y2 + drop}, ${edge.x2} ${edge.y2}`}
          fill="none"
          markerEnd="url(#workstream-loop-arrow)"
          stroke={stroke}
          strokeWidth="1.4"
        />
        <g>
          <title>{`Review loop — ${rounds} of ${cap} rework rounds used`}</title>
          <rect
            fill="#0d1117"
            height={15}
            rx="7"
            stroke={stroke}
            strokeWidth="1"
            width={40}
            x={midX - 20}
            y={badgeY - 7.5}
          />
          <text fill={stroke} fontSize="9" textAnchor="middle" x={midX} y={badgeY + 3}>
            {`⟲ ${rounds}/${cap}`}
          </text>
        </g>
      </g>
    );
  }
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

// Directed consult cross-edge (dotted teal): the asker consulted the target's
// frozen session. Clickable — reuses the dispatch-scroll mechanism to land on
// the consult site in the asker's chat. A midpoint badge counts repeat consults.
function ConsultGraphEdge({
  edge,
  onOpenDispatch,
}: {
  readonly edge: ConsultEdge;
  readonly onOpenDispatch: (
    threadId: ThreadId,
    anchorAtIso: string,
    expandConsultTargetId?: ThreadId,
  ) => void;
}) {
  const midX = (edge.x1 + edge.x2) / 2;
  const midY = (edge.y1 + edge.y2) / 2;
  const open = () => onOpenDispatch(edge.askerId, edge.anchorAtIso, edge.targetThreadId);
  return (
    <g
      className="ws-graph-consult-edge cursor-pointer outline-none"
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
      <title>{`Consulted: ${edge.preview}`}</title>
      {/* Invisible fat hit-target so the thin dotted line is easy to click. */}
      <path
        d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`}
        fill="none"
        stroke="transparent"
        strokeWidth="10"
      />
      <path
        d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`}
        fill="none"
        markerEnd="url(#workstream-consult-arrow)"
        stroke={CONSULT_STROKE}
        strokeDasharray="1.5 3"
        strokeWidth="1.3"
      />
      {edge.count > 1 ? (
        <g>
          <rect
            fill="#0d1117"
            height={15}
            rx="7"
            stroke={CONSULT_STROKE}
            strokeWidth="1"
            width={34}
            x={midX - 17}
            y={midY - 7.5}
          />
          <text fill={CONSULT_STROKE} fontSize="9" textAnchor="middle" x={midX} y={midY + 3}>
            {`×${edge.count}`}
          </text>
        </g>
      ) : null}
    </g>
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
  externalConsult,
}: {
  readonly node: Extract<LaidNode, { kind: "thread" }>;
  readonly threadById: ChildIndex;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
  readonly externalConsult: ExternalConsult | undefined;
}) {
  // The laid-out node carries a STRUCTURAL snapshot (layout is memoised on a key
  // that excludes status), so resolve the live summary for status/labels — else
  // a lane/attention change wouldn't recolour the node until the graph re-lays.
  const thread = threadById.get(node.thread.id) ?? node.thread;
  const status = getThreadStatus(thread, threadById);
  const verdictChip = getVerdictChip(thread);
  const gateWait = getGateWaitLabel(thread, threadById);
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
      {verdictChip ? (
        <GatePill
          fill={verdictChip.fill}
          label={truncateLabel(verdictChip.label, 20)}
          stroke={verdictChip.stroke}
          xEnd={node.x + node.w - 6}
          yCenter={node.y + node.h}
        />
      ) : null}
      {gateWait ? (
        // Straddles the TOP border so it never collides with the verdict chip
        // (the pair can exceed the card width side by side). An active leg reads
        // sky (live), a parked wait stays muted white.
        <GatePill
          fill={gateWait.active ? "#0d2231" : "#0d1117"}
          label={gateWait.label}
          stroke={gateWait.active ? "#38bdf8" : "rgba(255,255,255,0.4)"}
          xEnd={node.x + node.w - 6}
          yCenter={node.y}
        />
      ) : null}
      {externalConsult ? (
        // Out-of-tree consults have no node to point at, so annotate the asker
        // with a teal consult glyph + count; the hover names the external targets.
        <g>
          <title>{`Consulted outside this graph: ${externalConsult.targetTitles.join(", ")}`}</title>
          <circle
            cx={node.x + node.w - 12}
            cy={node.y + 12}
            fill="#0d1117"
            r="8"
            stroke={CONSULT_STROKE}
            strokeWidth="1"
          />
          <text
            fill={CONSULT_STROKE}
            fontSize="9"
            textAnchor="middle"
            x={node.x + node.w - 12}
            y={node.y + 15}
          >
            {externalConsult.count > 9 ? "9+" : externalConsult.count}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/** Small right-aligned pill straddling a card's bottom border (SVG). */
function GatePill({
  label,
  stroke,
  fill,
  xEnd,
  yCenter,
}: {
  readonly label: string;
  readonly stroke: string;
  readonly fill: string;
  readonly xEnd: number;
  readonly yCenter: number;
}) {
  const width = label.length * 4.6 + 10;
  return (
    <g>
      <rect
        fill={fill}
        height={13}
        rx="6.5"
        stroke={stroke}
        strokeWidth="1"
        width={width}
        x={xEnd - width}
        y={yCenter - 6.5}
      />
      <text fill={stroke} fontSize="8" textAnchor="middle" x={xEnd - width / 2} y={yCenter + 2.5}>
        {label}
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
