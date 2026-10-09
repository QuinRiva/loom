// Workstream fork–join graph — a READ-ONLY "dispatch episode" view. The
// orchestrator recurs as one BRIDGE node per wave (the children of one
// (parent, spawnGeneration)); waves stack down a neutral spine; within a wave,
// children sit in dependency columns; real `blockedBy` (within or across
// waves) draws as dashed cross-edges; a gated pair carries its loop edge with a ⟲ rounds/cap badge.
// Position encodes dispatch order; status is colour only (theme tokens).
//
// Gestures: click a node to enter its thread; hover (~300ms) for quick facts
// and a dependency highlight; middle-click for its timeline; right-click (or
// Shift+F10 / ContextMenu on a focused node) for actions. No animation loops.

import type { WorkstreamRollup } from "@t3tools/client-runtime/state/loom/rollup";
import type { ThreadId } from "@t3tools/contracts";
import { gateLoopTargetOf } from "@t3tools/shared/workstreamGraph";
import { GitForkIcon, MaximizeIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  computeForkJoinLayout,
  computeForkJoinViewBox,
  type ConsultEdge,
  deriveConsultOverlay,
  type ExternalConsult,
  type LaidEdge,
  type LaidNode,
  roundedPath,
  type ViewBox,
} from "../lib/forkJoinLayout";
import {
  ATTENTION_COLORS,
  ATTENTION_LABELS,
  COLUMN_LABELS,
  COLUMN_ORDER,
  COLUMN_STYLES,
  formatCompactAge,
  getGateLoopCap,
  formatStepAge,
  getNodeStateWord,
  getNodeStripLabel,
  getRoleLabel,
  getStep,
  getVerdictChip,
  isRunning,
  legibleHue,
  TONE_COLORS,
  truncateLabel,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
  wrapLabel,
} from "../lib/workstreamPresentation";
import { useNowMinute } from "../hooks/useNowMinute";
import { useWorkstreamUiStore } from "../loom/workstreamUiStore";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkstreamQuickFacts } from "./WorkstreamQuickFacts";

const SPINE_STROKE = "color-mix(in srgb, var(--color-foreground) 30%, transparent)";
const FORK_STROKE = "color-mix(in srgb, var(--color-foreground) 26%, transparent)";
const WAITS_ON_STROKE = COLUMN_STYLES.blocked.color;
const CONSULT_STROKE = "var(--color-info)";
const FORKED_FROM_STROKE = "var(--color-primary)";
const LOOP_STROKE = "var(--color-primary)";
// Done/cancelled cards recede so the live front reads first.
const RECEDE_OPACITY = 0.42;
const FADE_OPACITY = 0.1;
const STRIP_H = 20;
const HOVER_DELAY_MS = 300;
const FACTS_W = 300;
// A keyboard-focus outline shown only while its group has focus-visible.
const FOCUS_RING_CLASS = "opacity-0 group-focus-visible:opacity-100";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// The SVG letterboxes ("meet"), so pan/zoom maps through the effective scale.
const viewTransform = (rect: DOMRect, vb: ViewBox) => {
  const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
  return {
    scale,
    offsetX: (rect.width - vb.w * scale) / 2,
    offsetY: (rect.height - vb.h * scale) / 2,
  };
};

/** The loop edge's stroke: the gate source's latest verdict tone, else the base. */
const loopStrokeOf = (source: WorkstreamNode | undefined) => {
  const verdict = source ? getVerdictChip(source) : null;
  return verdict ? TONE_COLORS[verdict.tone] : LOOP_STROKE;
};

export default function WorkstreamGraph({
  viewKey,
  nodes: threads,
  byId,
  rollupOf,
  titleOf,
  onOpenThread,
  onOpenTimeline,
  onNodeContextMenu,
}: {
  /** Scoped root-thread key identifying this orchestration's saved view. */
  readonly viewKey: string;
  /** The orchestration: the root and every live descendant. */
  readonly nodes: ReadonlyArray<WorkstreamNode>;
  readonly byId: WorkstreamNodeIndex;
  readonly rollupOf: (threadId: ThreadId) => WorkstreamRollup | null;
  readonly titleOf: (threadId: ThreadId) => string;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenTimeline: (node: WorkstreamNode) => void;
  readonly onNodeContextMenu: (node: WorkstreamNode, position: { x: number; y: number }) => void;
}) {
  // Layout depends only on structure (lineage + generation + deps + loop routes
  // + order); loop rounds and status resolve live at render.
  const structureKey = threads
    .map(
      (t) =>
        `${t.id}>${t.parentThreadId ?? ""}@${t.spawnGeneration ?? ""}#${t.createdAt}:${t.blockedBy.join(",")}~${t.routes
          .filter((route) => route.kind === "loop")
          .map((route) => route.to ?? "")
          .join(",")}`,
    )
    .join("|");
  const { nodes, edges } = useMemo(() => computeForkJoinLayout(threads), [structureKey]);
  const consultOverlay = useMemo(
    () => deriveConsultOverlay(nodes, byId, edges),
    [nodes, byId, edges],
  );
  const base = useMemo(
    () => computeForkJoinViewBox(nodes, edges, consultOverlay.edges),
    [nodes, edges, consultOverlay],
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const factsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; vb: ViewBox } | null>(null);
  // Session-scoped saved view: returning to this orchestration restores the
  // zoom/pan the user left; Reset snaps back to fit-all.
  const saved = useWorkstreamUiStore.getState().graphViewByKey[viewKey];
  const setGraphView = useWorkstreamUiStore((store) => store.setGraphView);
  const [viewBox, setViewBox] = useState<ViewBox>(saved?.viewBox ?? base);
  const [adjusted, setAdjusted] = useState(saved?.adjusted ?? false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoveredId, setHoveredId] = useState<ThreadId | null>(null);
  const hovered = hoveredId === null ? undefined : byId.get(hoveredId);

  useEffect(() => {
    if (!adjusted) setViewBox(base);
  }, [base, adjusted]);

  useEffect(() => {
    setGraphView(viewKey, { viewBox, adjusted });
  }, [setGraphView, viewKey, viewBox, adjusted]);

  // The hovered node plus its structural and consult neighbours stay lit.
  const litKeys = useMemo(() => {
    if (hoveredId === null) return null;
    const lit = new Set<string>([hoveredId]);
    for (const edge of edges) {
      if (edge.fromKey === hoveredId || edge.toKey === hoveredId) {
        lit.add(edge.fromKey);
        lit.add(edge.toKey);
      }
    }
    for (const edge of consultOverlay.edges) {
      if (edge.askerId === hoveredId || edge.targetThreadId === hoveredId) {
        lit.add(edge.askerId);
        lit.add(edge.targetThreadId);
      }
    }
    return lit;
  }, [hoveredId, edges, consultOverlay]);

  // Last pointer / focused-element position, so the card is placed the moment
  // it mounts (the dwell often fires while the pointer is still).
  const pointerPosRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const focusPosRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const cancelHover = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    focusPosRef.current = null;
    setHoveredId(null);
  };
  const scheduleHover = (threadId: ThreadId) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoveredId(threadId), HOVER_DELAY_MS);
  };
  const focusHover = (threadId: ThreadId, el: Element) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const rect = el.getBoundingClientRect();
    focusPosRef.current = { clientX: rect.left + rect.width / 2, clientY: rect.bottom };
    setHoveredId(threadId);
  };
  // Cursor-relative, flipped to stay inside the shell; imperative so tracking
  // the pointer never re-renders the SVG.
  const positionFacts = (event: { clientX: number; clientY: number }) => {
    const shell = shellRef.current;
    const card = factsRef.current;
    if (!shell || !card) return;
    const rect = shell.getBoundingClientRect();
    const cardH = card.offsetHeight || 180;
    let x = event.clientX - rect.left + 16;
    let y = event.clientY - rect.top + 14;
    if (x + FACTS_W > rect.width) x = Math.max(6, event.clientX - rect.left - FACTS_W - 10);
    if (y + cardH > rect.height) y = Math.max(6, rect.height - cardH - 10);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  };

  useEffect(() => () => cancelHover(), []);
  useLayoutEffect(() => {
    if (hoveredId === null) return;
    const at = focusPosRef.current ?? pointerPosRef.current;
    if (at) positionFacts(at);
    focusPosRef.current = null;
  }, [hoveredId]);

  // Zoom about a client-space anchor (wheel cursor); buttons zoom the centre.
  const zoomBy = (factor: number, client?: { x: number; y: number }) => {
    setAdjusted(true);
    setViewBox((vb) => {
      const w = clamp(vb.w * factor, base.w * 0.25, base.w * 4);
      const h = w * (vb.h / vb.w);
      let ax = 0.5;
      let ay = 0.5;
      const svg = svgRef.current;
      if (client && svg) {
        const rect = svg.getBoundingClientRect();
        const { scale, offsetX, offsetY } = viewTransform(rect, vb);
        ax = clamp((client.x - rect.left - offsetX) / (scale * vb.w), 0, 1);
        ay = clamp((client.y - rect.top - offsetY) / (scale * vb.h), 0, 1);
      }
      return { x: vb.x + (vb.w - w) * ax, y: vb.y + (vb.h - h) * ay, w, h };
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
      zoomBy(event.deltaY < 0 ? 0.88 : 1 / 0.88, { x: event.clientX, y: event.clientY });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [base]);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest("[data-graph-hit]")) return;
    dragRef.current = { x: event.clientX, y: event.clientY, vb: viewBox };
    setAdjusted(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { scale } = viewTransform(event.currentTarget.getBoundingClientRect(), drag.vb);
    setViewBox({
      ...drag.vb,
      x: drag.vb.x - (event.clientX - drag.x) / scale,
      y: drag.vb.y - (event.clientY - drag.y) / scale,
    });
  };
  const endPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div className="relative w-full" ref={shellRef}>
        <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
          <GraphControlButton label="Zoom in" onClick={() => zoomBy(0.8)}>
            <ZoomInIcon />
          </GraphControlButton>
          <GraphControlButton label="Zoom out" onClick={() => zoomBy(1.25)}>
            <ZoomOutIcon />
          </GraphControlButton>
          <GraphControlButton label="Reset view" onClick={resetView}>
            <MaximizeIcon />
          </GraphControlButton>
        </div>
        <svg
          ref={svgRef}
          className="w-full cursor-grab touch-none rounded-xl border border-border bg-muted active:cursor-grabbing"
          // Fit-to-content: the box mirrors the laid-out content's aspect ratio.
          style={{ aspectRatio: `${base.w} / ${base.h}`, maxHeight: "60vh" }}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label="Workstream fork–join graph"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <defs>
            <ArrowMarker id="workstream-arrow" fill={FORK_STROKE} />
            <ArrowMarker id="workstream-waits-arrow" fill={WAITS_ON_STROKE} />
            {/* `context-stroke`: the head inherits the loop path's live stroke. */}
            <ArrowMarker id="workstream-loop-arrow" fill="context-stroke" />
            <ArrowMarker id="workstream-consult-arrow" fill={CONSULT_STROKE} />
          </defs>
          {edges.map((edge) => (
            <GraphEdge
              key={edge.key}
              edge={edge}
              byId={byId}
              dimmed={hoveredId !== null && edge.fromKey !== hoveredId && edge.toKey !== hoveredId}
            />
          ))}
          {consultOverlay.edges.map((edge) => (
            <ConsultGraphEdge
              key={edge.key}
              edge={edge}
              onOpenThread={onOpenThread}
              dimmed={
                hoveredId !== null &&
                edge.askerId !== hoveredId &&
                edge.targetThreadId !== hoveredId
              }
            />
          ))}
          {nodes.map((node) =>
            node.kind === "bridge" ? (
              <BridgeNode
                key={node.key}
                node={node}
                onOpenThread={onOpenThread}
                dimmed={litKeys !== null && !litKeys.has(node.key)}
              />
            ) : (
              <GraphNode
                key={node.key}
                laid={node}
                byId={byId}
                dimmed={litKeys !== null && !litKeys.has(node.thread.id)}
                titleOf={titleOf}
                onOpenThread={onOpenThread}
                onOpenTimeline={(thread) => {
                  cancelHover();
                  onOpenTimeline(thread);
                }}
                onContextMenu={(thread, position) => {
                  cancelHover();
                  onNodeContextMenu(thread, position);
                }}
                onHoverStart={() => scheduleHover(node.thread.id)}
                onHoverMove={(event) => {
                  pointerPosRef.current = { clientX: event.clientX, clientY: event.clientY };
                  positionFacts(event);
                }}
                onHoverEnd={cancelHover}
                onFocusStart={(el) => focusHover(node.thread.id, el)}
                externalConsult={consultOverlay.externalByAskerId.get(node.thread.id)}
              />
            ),
          )}
          {nodes.length === 0 ? (
            <text
              className="fill-muted-foreground"
              fontSize="13"
              textAnchor="middle"
              x={160}
              y={120}
            >
              No sub-threads yet.
            </text>
          ) : null}
        </svg>
        {hovered ? (
          <WorkstreamQuickFacts
            ref={factsRef}
            node={hovered}
            byId={byId}
            rollup={rollupOf(hovered.id)}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 px-2 pb-1">
        {COLUMN_ORDER.map((column) => (
          <LegendItem
            key={column}
            swatch={<span className={`size-2 rounded-full ${COLUMN_STYLES[column].dotClass}`} />}
          >
            {COLUMN_LABELS[column]}
          </LegendItem>
        ))}
        <LegendItem swatch={<LineSwatch color={SPINE_STROKE} line="solid" />}>
          dispatch spine
        </LegendItem>
        <LegendItem swatch={<LineSwatch color={WAITS_ON_STROKE} line="dashed" />}>
          waits-on
        </LegendItem>
        <LegendItem swatch={<LineSwatch color={LOOP_STROKE} line="solid" />}>
          review loop ⟲
        </LegendItem>
        <LegendItem swatch={<LineSwatch color={CONSULT_STROKE} line="dotted" />}>
          consult
        </LegendItem>
        <LegendItem
          swatch={
            <GitForkIcon className="size-3" style={{ color: legibleHue(FORKED_FROM_STROKE) }} />
          }
        >
          forked from
        </LegendItem>
      </div>
    </div>
  );
}

function LegendItem({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
      {swatch}
      {children}
    </span>
  );
}

function LineSwatch({ color, line }: { color: string; line: "solid" | "dashed" | "dotted" }) {
  return (
    <span
      className="inline-block h-0 w-4 border-t"
      style={{ borderColor: color, borderStyle: line }}
    />
  );
}

function ArrowMarker({ id, fill }: { id: string; fill: string }) {
  return (
    <marker id={id} markerHeight="8" markerWidth="8" orient="auto" refX="6" refY="3">
      <path d="M0 0 L6 3 L0 6 z" fill={fill} />
    </marker>
  );
}

function GraphEdge({
  edge,
  byId,
  dimmed,
}: {
  readonly edge: LaidEdge;
  readonly byId: WorkstreamNodeIndex;
  readonly dimmed: boolean;
}) {
  const opacity = dimmed ? FADE_OPACITY : 1;
  const midX = (edge.x1 + edge.x2) / 2;
  const spline = `M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`;
  if (edge.kind === "loop") {
    // A review gate's return arrow, routed in the channel below the pair. The
    // badge reads rounds used of the cap; the stroke the latest verdict.
    const source = edge.sourceId ? byId.get(edge.sourceId) : undefined;
    const rounds = source?.gateRounds ?? 0;
    const cap = source ? getGateLoopCap(source) : rounds;
    const stroke = loopStrokeOf(source);
    const loopTo = source ? gateLoopTargetOf(source) : null;
    const target = loopTo === null ? undefined : byId.get(loopTo);
    const badge = edge.badge ?? { x: midX, y: (edge.y1 + edge.y2) / 2 };
    const verdict = source?.lastOutcome?.outcome;
    return (
      <g opacity={opacity}>
        <path
          d={
            edge.points
              ? roundedPath(edge.points)
              : `M ${edge.x1} ${edge.y1} L ${edge.x2} ${edge.y2}`
          }
          fill="none"
          markerEnd="url(#workstream-loop-arrow)"
          stroke={stroke}
          strokeWidth="1.4"
        />
        <g>
          <title>{`Review loop — ${rounds} of ${cap} rework rounds used${
            target?.pendingRework ? " · rework round open" : ""
          }${verdict ? ` · latest verdict: ${verdict.replaceAll("_", " ")}` : ""}`}</title>
          <rect
            fill="var(--color-background)"
            height={15}
            rx="7"
            stroke={stroke}
            strokeWidth="1"
            width={target?.pendingRework ? 52 : 40}
            x={badge.x - (target?.pendingRework ? 26 : 20)}
            y={badge.y - 7.5}
          />
          <text
            fill={legibleHue(stroke)}
            fontSize="9"
            textAnchor="middle"
            x={badge.x}
            y={badge.y + 3}
          >
            {`⟲ ${rounds}/${cap}${target?.pendingRework ? " ●" : ""}`}
          </text>
        </g>
      </g>
    );
  }
  if (edge.kind === "spine") {
    return (
      <line
        opacity={opacity}
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
    return (
      <path
        opacity={opacity}
        d={spline}
        fill="none"
        markerEnd="url(#workstream-arrow)"
        stroke={FORK_STROKE}
        strokeWidth="1.4"
      />
    );
  }
  return (
    <path
      opacity={opacity}
      d={edge.points ? roundedPath(edge.points) : spline}
      fill="none"
      markerEnd="url(#workstream-waits-arrow)"
      stroke={WAITS_ON_STROKE}
      strokeDasharray="4 3"
      strokeWidth="1.3"
    />
  );
}

// Directed consult cross-edge (dotted): the asker consulted the target's frozen
// session. Clicking opens the asker; a badge counts repeat consults.
function ConsultGraphEdge({
  edge,
  onOpenThread,
  dimmed,
}: {
  readonly edge: ConsultEdge;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly dimmed: boolean;
}) {
  const midX = (edge.x1 + edge.x2) / 2;
  const badge = edge.badge ?? { x: midX, y: (edge.y1 + edge.y2) / 2 };
  const open = () => onOpenThread(edge.askerId);
  const d = edge.points
    ? roundedPath(edge.points)
    : `M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`;
  return (
    <g
      data-graph-hit
      className="group cursor-pointer outline-none"
      opacity={dimmed ? FADE_OPACITY : 1}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      role="button"
      aria-label={`Consulted: ${edge.preview}`}
      tabIndex={0}
    >
      <title>{`Consulted: ${edge.preview}`}</title>
      <path d={d} fill="none" stroke="transparent" strokeWidth="10" />
      <path
        className={FOCUS_RING_CLASS}
        d={d}
        fill="none"
        stroke="var(--color-ring)"
        strokeWidth="3"
      />
      <path
        d={d}
        fill="none"
        markerEnd="url(#workstream-consult-arrow)"
        stroke={CONSULT_STROKE}
        strokeDasharray="1.5 3"
        strokeWidth="1.3"
      />
      {edge.count > 1 ? (
        <g>
          <rect
            fill="var(--color-background)"
            height={15}
            rx="7"
            stroke={CONSULT_STROKE}
            strokeWidth="1"
            width={34}
            x={badge.x - 17}
            y={badge.y - 7.5}
          />
          <text
            fill={legibleHue(CONSULT_STROKE)}
            fontSize="9"
            textAnchor="middle"
            x={badge.x}
            y={badge.y + 3}
          >
            {`×${edge.count}`}
          </text>
        </g>
      ) : null}
    </g>
  );
}

function BridgeNode({
  node,
  onOpenThread,
  dimmed,
}: {
  readonly node: Extract<LaidNode, { kind: "bridge" }>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly dimmed: boolean;
}) {
  const open = () => onOpenThread(node.orchestratorId);
  return (
    <g
      data-graph-hit
      className="group cursor-pointer outline-none"
      opacity={dimmed ? FADE_OPACITY : 1}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      role="button"
      aria-label={`Open the orchestrator of wave ${node.waveIndex}`}
      tabIndex={0}
    >
      <title>{`Open the orchestrator of wave ${node.waveIndex}`}</title>
      <rect
        className="fill-foreground/7 stroke-foreground/18"
        height={node.h}
        rx="11"
        width={node.w}
        x={node.x}
        y={node.y}
      />
      <FocusRing x={node.x} y={node.y} w={node.w} h={node.h} rx={11} />
      <text
        className="fill-foreground/80"
        fontSize="12"
        fontWeight="600"
        textAnchor="middle"
        x={node.x + node.w / 2}
        y={node.y + 19}
      >
        {truncateLabel(node.label, 18)}
      </text>
      <text
        className="fill-muted-foreground"
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

function CornerBadge({
  cx,
  cy,
  stroke,
  title,
  children,
}: {
  cx: number;
  cy: number;
  stroke: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <g>
      <title>{title}</title>
      <circle
        cx={cx}
        cy={cy}
        fill="var(--color-background)"
        r="8"
        stroke={stroke}
        strokeWidth="1"
      />
      {typeof children === "object" ? (
        children
      ) : (
        <text fill={legibleHue(stroke)} fontSize="9" textAnchor="middle" x={cx} y={cy + 3.5}>
          {children}
        </text>
      )}
    </g>
  );
}

function GraphNode({
  laid,
  byId,
  dimmed,
  titleOf,
  onOpenThread,
  onOpenTimeline,
  onContextMenu,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
  onFocusStart,
  externalConsult,
}: {
  readonly laid: Extract<LaidNode, { kind: "thread" }>;
  readonly byId: WorkstreamNodeIndex;
  readonly dimmed: boolean;
  readonly titleOf: (threadId: ThreadId) => string;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenTimeline: (node: WorkstreamNode) => void;
  readonly onContextMenu: (node: WorkstreamNode, position: { x: number; y: number }) => void;
  readonly onHoverStart: () => void;
  readonly onHoverMove: (event: { clientX: number; clientY: number }) => void;
  readonly onHoverEnd: () => void;
  readonly onFocusStart: (el: Element) => void;
  readonly externalConsult: ExternalConsult | undefined;
}) {
  // The laid node is a structural snapshot; resolve the live one for status.
  const node = byId.get(laid.thread.id) ?? laid.thread;
  const { x, y, w, h } = laid;
  const color = COLUMN_STYLES[node.column].color;
  const verdict = getVerdictChip(node);
  const stateWord = getNodeStateWord(node, byId);
  const reason = node.reasons[0];
  const recede = node.column === "done" || node.column === "cancelled";
  const running = isRunning(node);
  // Ages and step durations tick on the shared minute clock (no per-node timer).
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const step = getStep(node, now);
  const stepAge = step && formatStepAge(step.since, now);
  // The footer's age ends left of the corner badges; both lines lift clear of a verdict pill.
  const footerEnd = x + w - 10 - (node.forkFromThreadId ? 20 : 0) - (externalConsult ? 20 : 0);
  const footerY = y + h - (verdict ? 10 : 8);
  const titleLines = wrapLabel(node.title, 24, 2);
  const roleLabel = getRoleLabel(node);
  const forkBadgeX = x + w - 12;
  const consultBadgeX = forkBadgeX - (node.forkFromThreadId ? 20 : 0);
  return (
    <g
      data-graph-hit
      role="group"
      aria-label={`${roleLabel} ${node.title}`}
      onMouseEnter={onHoverStart}
      onMouseMove={onHoverMove}
      onMouseLeave={onHoverEnd}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(node, { x: event.clientX, y: event.clientY });
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenTimeline(node);
      }}
    >
      <g
        className="group cursor-pointer outline-none"
        role="button"
        aria-label={`Open thread ${node.title}`}
        tabIndex={0}
        onClick={() => onOpenThread(node.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpenThread(node.id);
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onContextMenu(node, { x: rect.left + rect.width / 2, y: rect.bottom });
          }
        }}
        onFocus={(event) => onFocusStart(event.currentTarget)}
        onBlur={onHoverEnd}
      >
        <FocusRing x={x} y={y} w={w} h={h} rx={10} />
        <g opacity={dimmed ? FADE_OPACITY : recede ? RECEDE_OPACITY : 1}>
          <rect
            fill={`color-mix(in srgb, ${color} 14%, var(--color-background))`}
            height={h}
            rx="10"
            stroke={color}
            strokeWidth={1.4}
            width={w}
            x={x}
            y={y}
          />
          {reason ? (
            // Attention ring in the highest reason's colour (static — no pulse).
            <rect
              fill="none"
              height={h + 5}
              pointerEvents="none"
              rx="12"
              stroke={ATTENTION_COLORS[reason]}
              strokeWidth={2}
              width={w + 5}
              x={x - 2.5}
              y={y - 2.5}
            >
              <title>{ATTENTION_LABELS[reason]}</title>
            </rect>
          ) : null}
          <path
            d={`M ${x + 10} ${y} H ${x + w - 10} A 10 10 0 0 1 ${x + w} ${y + 10} V ${y + STRIP_H} H ${x} V ${y + 10} A 10 10 0 0 1 ${x + 10} ${y} Z`}
            fill={color}
            fillOpacity="0.16"
          />
          <text
            fill={legibleHue(color)}
            fontSize="8"
            fontWeight="600"
            letterSpacing="0.06em"
            x={x + 10}
            y={y + 13.5}
          >
            {getNodeStripLabel(node, stateWord)}
          </text>
          {running ? (
            <circle cx={x + w - 16 - stateWord.length * 4.4} cy={y + 10.5} r={2.6} fill={color} />
          ) : null}
          <text fill={legibleHue(color)} fontSize="8" textAnchor="end" x={x + w - 10} y={y + 13.5}>
            {stateWord}
          </text>
          <text className="fill-foreground" fontSize="11" fontWeight="600">
            <tspan x={x + 10} y={y + 35}>
              {titleLines[0] ?? ""}
            </tspan>
            {titleLines[1] !== undefined ? (
              <tspan x={x + 10} y={y + 48}>
                {titleLines[1]}
              </tspan>
            ) : null}
          </text>
          {verdict ? (
            <GatePill
              label={truncateLabel(verdict.label, 20)}
              stroke={TONE_COLORS[verdict.tone]}
              xEnd={x + w - 6}
              yCenter={y + h}
            />
          ) : null}
          {node.forkFromThreadId ? (
            <CornerBadge
              cx={forkBadgeX}
              cy={y + h - 12}
              stroke={FORKED_FROM_STROKE}
              title={`Forked from ${titleOf(node.forkFromThreadId)}`}
            >
              <GitForkIcon
                x={forkBadgeX - 5}
                y={y + h - 17}
                width={10}
                height={10}
                color={legibleHue(FORKED_FROM_STROKE)}
              />
            </CornerBadge>
          ) : null}
          {externalConsult ? (
            <CornerBadge
              cx={consultBadgeX}
              cy={y + h - 12}
              stroke={CONSULT_STROKE}
              title={`Consulted outside this graph: ${externalConsult.targetTitles.join(", ")}`}
            >
              {externalConsult.count > 9 ? "9+" : externalConsult.count}
            </CornerBadge>
          ) : null}
          {node.column === "in_progress" ? (
            <g
              className="fill-muted-foreground"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fontSize={8.5}
              pointerEvents="none"
            >
              <text x={x + 10} y={footerY}>
                {step ? truncateLabel(step.label, 16) : (node.activity ?? "idle")}
                {stepAge ? (
                  <>
                    {" · "}
                    <tspan
                      className={step?.long ? "fill-warning-foreground" : undefined}
                      fontWeight={step?.long ? 600 : undefined}
                    >
                      {stepAge}
                    </tspan>
                  </>
                ) : null}
              </text>
              <text textAnchor="end" x={footerEnd} y={footerY}>
                {formatCompactAge(node.lastActivityAt, now)}
              </text>
            </g>
          ) : null}
        </g>
      </g>
    </g>
  );
}

function FocusRing({ x, y, w, h, rx }: { x: number; y: number; w: number; h: number; rx: number }) {
  return (
    <rect
      className={FOCUS_RING_CLASS}
      x={x - 3}
      y={y - 3}
      width={w + 6}
      height={h + 6}
      rx={rx + 2}
      fill="none"
      stroke="var(--color-ring)"
      strokeWidth="2"
      pointerEvents="none"
    />
  );
}

/** A right-aligned pill straddling a card's bottom border. */
function GatePill({
  label,
  stroke,
  xEnd,
  yCenter,
}: {
  label: string;
  stroke: string;
  xEnd: number;
  yCenter: number;
}) {
  const width = label.length * 4.6 + 10;
  return (
    <g>
      <rect
        fill={`color-mix(in srgb, ${stroke} 18%, var(--color-background))`}
        height={13}
        rx="6.5"
        stroke={stroke}
        strokeWidth="1"
        width={width}
        x={xEnd - width}
        y={yCenter - 6.5}
      />
      <text
        fill={legibleHue(stroke)}
        fontSize="8"
        textAnchor="middle"
        x={xEnd - width / 2}
        y={yCenter + 2.5}
      >
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
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button aria-label={label} onClick={onClick} size="icon-xs" variant="outline" />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
