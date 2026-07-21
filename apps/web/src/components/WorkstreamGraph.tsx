// Workstream fork–join graph — a deliberately READ-ONLY "dispatch episode" view.
// The orchestrator is not a single root: it recurs as one BRIDGE node per wave,
// where a wave = the children of one (parentThreadId, spawnGeneration) — the set
// the engine spawns before it next regains control. Waves stack down a neutral
// solid spine ordered by each wave's earliest child; within a wave, children sit
// in dependency columns and real `blockedBy` edges are dashed-steel cross-edges.
// Nesting (a child that itself spawns) is the same layout applied recursively and
// packed as a measured block. Position encodes temporal/causal dispatch order;
// status is colour only. Hand-rolled band layout + zero-dependency pan/zoom.
//
// Interaction (redesign): the cheapest gesture ENTERS a thread — clicking a node
// opens its conversation. Hovering (~300ms) surfaces a quick-facts card and a
// dependency highlight (the node's edges + neighbours light, the rest recede);
// right-clicking a node (or Shift+F10 / the ContextMenu key on a focused node)
// opens a state-aware context menu of secondary actions. Running/yielded nodes
// carry a compact live footer (⚒ tools · age). Done/cancelled nodes dim so the
// live front is what the eye lands on. The canvas is sized to its content.
//
// If this ever becomes an EDITABLE orchestration canvas (drag to rewire, minimap),
// refactor to React Flow — see docs/research/workstream-dag-visualization.md.

import type { ThreadId } from "@t3tools/contracts";
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";

import { useWorkstreamUiStore } from "../loom/workstreamUiStore";
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
  deriveConsultOverlay,
  roundedPath,
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
  getAttentionPulse,
  getFanInBadge,
  getGateLoopCap,
  getLoopEdgeStroke,
  getLoopStroke,
  getNodeFooter,
  getNodeStateWord,
  getRoleLabel,
  getThreadStatus,
  getVerdictChip,
  CONSULT_STROKE,
  STATUS_STYLES,
  truncateLabel,
  WAITS_ON_STROKE,
  wrapLabel,
} from "../lib/workstreamPresentation";
import type { SidebarThreadSummary } from "../types";
import { WorkstreamQuickFacts } from "./WorkstreamQuickFacts";

const SPINE_STROKE = "rgba(255,255,255,0.30)";
// Thread fork (forkFromThreadId): a distinct violet for the “forked from”
// lineage glyph, not conflated with the fork-join spine (FORK_STROKE below),
// consult (teal), loop, or waits-on (steel).
const FORKED_FROM_STROKE = "#c084fc";
const FORK_STROKE = "rgba(255,255,255,0.26)";
// Done/cancelled cards recede to this opacity so the live front reads first
// (matches the approved mockup's ~0.42). Overridden by the hover highlight.
const RECEDE_OPACITY = 0.42;
// Header-strip height of the C2 card (role · pulse · state word band).
const STRIP_H = 20;
const FADE_OPACITY = 0.1;
const HOVER_DELAY_MS = 300;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// The SVG letterboxes (preserveAspectRatio "meet") when its box aspect differs
// from the viewBox, so pan/zoom maths must map through the effective scale and
// centring offsets rather than assuming the viewBox fills the element.
const viewTransform = (rect: DOMRect, vb: ViewBox) => {
  const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
  return {
    scale,
    offsetX: (rect.width - vb.w * scale) / 2,
    offsetY: (rect.height - vb.h * scale) / 2,
  };
};

export default function WorkstreamGraph({
  viewKey,
  threads,
  threadById,
  onOpenThread,
  onOpenHistory,
  onNodeContextMenu,
  onOpenDispatch,
}: {
  /** Scoped root-thread key identifying this orchestration's saved view. */
  readonly viewKey: string;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly threadById: ChildIndex;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
  readonly onOpenHistory: (thread: SidebarThreadSummary) => void;
  readonly onNodeContextMenu: (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => void;
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

  // Consult overlay is derived live (not part of the memoised structural layout)
  // so newly-recorded consults appear without a re-layout — mirroring how loop
  // rounds are resolved at render time.
  const consultOverlay = useMemo(
    () => deriveConsultOverlay(nodes, threadById, edges),
    [nodes, threadById, edges],
  );

  // Bounds include routed edge geometry (loop + backward-consult channels and
  // their badges) so a back-edge dipping below the last row is never clipped and
  // its hit-target stays reachable. Consults are live, so they join here.
  const base = useMemo(
    () => computeForkJoinViewBox(nodes, edges, consultOverlay.edges),
    [nodes, edges, consultOverlay],
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const factsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; vb: ViewBox } | null>(null);
  // Session-scoped saved view: re-opening a thread of this orchestration
  // restores the zoom/pan the user left it at instead of resetting
  // (predictable interface). Reset view still snaps back to fit-all.
  const saved = useWorkstreamUiStore.getState().graphViewByKey[viewKey];
  const setGraphView = useWorkstreamUiStore((store) => store.setGraphView);
  const [viewBox, setViewBox] = useState<ViewBox>(saved?.viewBox ?? base);
  const [adjusted, setAdjusted] = useState(saved?.adjusted ?? false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The hovered thread (after the dwell) drives the quick-facts card + the
  // dependency highlight. Position is set imperatively (below) to avoid
  // re-rendering the whole SVG on every mousemove.
  const [hovered, setHovered] = useState<{
    readonly thread: SidebarThreadSummary;
    readonly key: string;
  } | null>(null);

  useEffect(() => {
    if (!adjusted) setViewBox(base);
  }, [base, adjusted]);

  useEffect(() => {
    setGraphView(viewKey, { viewBox, adjusted });
  }, [setGraphView, viewKey, viewBox, adjusted]);

  // The set of node keys to keep lit while hovering: the hovered node plus every
  // neighbour reachable across a structural or consult edge. Null ⇒ not hovering
  // (nothing recedes for the highlight; the done/cancelled recession still runs).
  const litKeys = useMemo(() => {
    const hoveredKey = hovered?.key;
    if (!hoveredKey) return null;
    const lit = new Set<string>([hoveredKey]);
    for (const edge of edges) {
      if (edge.fromKey === hoveredKey || edge.toKey === hoveredKey) {
        lit.add(edge.fromKey);
        lit.add(edge.toKey);
      }
    }
    for (const edge of consultOverlay.edges) {
      if (edge.askerId === hoveredKey || edge.targetThreadId === hoveredKey) {
        lit.add(edge.askerId);
        lit.add(edge.targetThreadId);
      }
    }
    return lit;
  }, [hovered, edges, consultOverlay]);

  // Pending facts position for a KEYBOARD focus (no cursor): captured from the
  // focused element's rect and applied after the card mounts.
  const focusPosRef = useRef<{ clientX: number; clientY: number } | null>(null);
  // Last pointer position, tracked continuously so the card can be placed the
  // moment it mounts: the dwell timer often fires while the pointer is
  // STATIONARY, and waiting for the next mousemove leaves the card unpositioned
  // (it flashed at a stale corner) until the pointer twitches.
  const pointerPosRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const cancelHover = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    focusPosRef.current = null;
    setHovered(null);
  };
  const scheduleHover = (thread: SidebarThreadSummary, key: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHovered({ thread, key }), HOVER_DELAY_MS);
  };
  // Keyboard focus mirrors hover immediately (no dwell): show facts + highlight
  // as soon as a node's open button is focused, positioned from its rect.
  const focusHover = (thread: SidebarThreadSummary, key: string, el: Element) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const rect = el.getBoundingClientRect();
    focusPosRef.current = { clientX: rect.left + rect.width / 2, clientY: rect.bottom };
    setHovered({ thread, key });
  };
  // Position the quick-facts card imperatively (cursor-relative, flipped to stay
  // inside the shell), so tracking the pointer never re-renders the SVG.
  const positionFacts = (event: { clientX: number; clientY: number }) => {
    const shell = shellRef.current;
    const card = factsRef.current;
    if (!shell || !card) return;
    const rect = shell.getBoundingClientRect();
    const cardW = 256;
    const cardH = card.offsetHeight || 180;
    let x = event.clientX - rect.left + 16;
    let y = event.clientY - rect.top + 14;
    if (x + cardW > rect.width) x = Math.max(6, event.clientX - rect.left - cardW - 10);
    if (y + cardH > rect.height) y = Math.max(6, rect.height - cardH - 10);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  };

  useEffect(() => () => cancelHover(), []);
  // Place the card the moment it mounts: from the focused element's rect for a
  // keyboard focus, else from the last tracked pointer position. Mousemove then
  // keeps it tracking imperatively.
  useLayoutEffect(() => {
    if (!hovered) return;
    const at = focusPosRef.current ?? pointerPosRef.current;
    if (at) positionFacts(at);
    focusPosRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered]);

  // Zoom about a client-space anchor (wheel cursor); button zooms centre.
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
    const { scale } = viewTransform(rect, drag.vb);
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

  const highlighting = litKeys !== null;

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <p className="px-2 text-center text-[11px] leading-relaxed text-white/35">
        The orchestrator recurs as a bridge node per dispatch wave down the solid spine; children of
        a wave sit to its right, with dashed steel &ldquo;waits-on&rdquo; cross-edges. Click a node
        to open its thread; middle-click for its history; hover for its facts; right-click for
        actions.
      </p>
      <div className="relative w-full" ref={shellRef}>
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
          className="w-full touch-none cursor-grab rounded-xl border border-white/10 bg-black/20 active:cursor-grabbing"
          // Fit-to-content: the SVG's box mirrors the laid-out content's aspect
          // ratio (capped), so a small graph is compact instead of floating in a
          // tall dead canvas. Zoom/pan preserve the ratio, so this stays correct.
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
            {/* One restrained pulse for human-blocking attention; stilled under
                prefers-reduced-motion so it never becomes a motion nuisance. The
                highlight fade is likewise a plain opacity swap. */}
            <style>{`
              @keyframes wsAttentionPulse {
                0%, 100% { stroke-opacity: 0.95; stroke-width: 1.4; }
                50% { stroke-opacity: 0.28; stroke-width: 3.4; }
              }
              .ws-attention-pulse { animation: wsAttentionPulse 1.8s ease-in-out infinite; }
              @keyframes wsFooterPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
              .ws-footer-live { animation: wsFooterPulse 1.8s ease-in-out infinite; }
              .ws-graph-node, .ws-graph-edge, .ws-graph-consult-edge { transition: opacity 0.18s; }
              /* Visible keyboard focus for every SVG affordance (replaces the
                 removed default outline), plus the graph control buttons. */
              .ws-focus-ring { opacity: 0; }
              .ws-graph-open:focus-visible,
              .ws-graph-bridge:focus-visible, .ws-graph-consult-edge:focus-visible { outline: none; }
              .ws-graph-open:focus-visible .ws-focus-ring,
              .ws-graph-bridge:focus-visible .ws-focus-ring,
              .ws-graph-consult-edge:focus-visible .ws-focus-ring { opacity: 1; }
              @media (prefers-reduced-motion: reduce) {
                .ws-attention-pulse { animation: none; stroke-opacity: 0.9; }
                .ws-footer-live { animation: none; opacity: 1; }
                .ws-graph-node, .ws-graph-edge, .ws-graph-consult-edge { transition: none; }
              }
            `}</style>
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
              {/* `context-stroke` makes the arrowhead inherit the loop path's
                  live verdict-tinted stroke, so head and line always match. */}
              <path d="M0 0 L6 3 L0 6 z" fill="context-stroke" />
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
            <GraphEdge
              key={edge.key}
              edge={edge}
              threadById={threadById}
              dimmed={highlighting && !isEdgeLit(edge, hovered?.key)}
            />
          ))}
          {consultOverlay.edges.map((edge) => (
            <ConsultGraphEdge
              key={edge.key}
              edge={edge}
              onOpenDispatch={onOpenDispatch}
              dimmed={
                highlighting &&
                edge.askerId !== hovered?.key &&
                edge.targetThreadId !== hovered?.key
              }
            />
          ))}
          {nodes.map((node) =>
            node.kind === "bridge" ? (
              <BridgeNode
                key={node.key}
                node={node}
                onOpenDispatch={onOpenDispatch}
                dimmed={litKeys !== null && !litKeys.has(node.key)}
              />
            ) : (
              <GraphNode
                key={node.key}
                node={node}
                threadById={threadById}
                dimmed={litKeys !== null && !litKeys.has(node.thread.id)}
                onOpenThread={onOpenThread}
                onOpenHistory={onOpenHistory}
                onNodeContextMenu={onNodeContextMenu}
                onHoverStart={(thread) => scheduleHover(thread, node.thread.id)}
                onHoverMove={(event) => {
                  pointerPosRef.current = { clientX: event.clientX, clientY: event.clientY };
                  positionFacts(event);
                }}
                onHoverEnd={cancelHover}
                onFocusStart={(thread, el) => focusHover(thread, node.thread.id, el)}
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
        {hovered ? (
          <WorkstreamQuickFacts ref={factsRef} thread={hovered.thread} threadById={threadById} />
        ) : null}
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
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/45">
          <span className="text-[11px]" style={{ color: FORKED_FROM_STROKE }}>
            ⑂
          </span>
          forked from
        </span>
      </div>
    </div>
  );
}

/** Whether a structural edge touches the hovered node key. */
function isEdgeLit(edge: LaidEdge, hoveredKey: string | undefined): boolean {
  return hoveredKey !== undefined && (edge.fromKey === hoveredKey || edge.toKey === hoveredKey);
}

function GraphEdge({
  edge,
  threadById,
  dimmed,
}: {
  readonly edge: LaidEdge;
  readonly threadById: ChildIndex;
  readonly dimmed: boolean;
}) {
  const opacity = dimmed ? FADE_OPACITY : 1;
  if (edge.kind === "loop") {
    // Return arrow of a review gate: a shallow rounded orthogonal loop routed in
    // the channel BELOW the gate pair (never a diagonal through a card body).
    // Stroke is tinted by the gate source's latest verdict (amber while rework
    // pends, emerald once settled) over a violet round-depth base; the badge on
    // the straight channel run shows rounds vs cap. Both resolve live so the edge
    // recolours without re-layout.
    const source = edge.sourceId ? threadById.get(edge.sourceId) : undefined;
    const rounds = source?.gateRounds ?? 0;
    const cap = source ? getGateLoopCap(source) : rounds;
    const stroke = source ? getLoopEdgeStroke(source) : getLoopStroke(rounds);
    const verdict = source?.lastOutcome?.outcome;
    const badge = edge.badge ?? { x: (edge.x1 + edge.x2) / 2, y: (edge.y1 + edge.y2) / 2 };
    const d = edge.points
      ? roundedPath(edge.points)
      : `M ${edge.x1} ${edge.y1} L ${edge.x2} ${edge.y2}`;
    return (
      <g className="ws-graph-edge" opacity={opacity}>
        <path
          d={d}
          fill="none"
          markerEnd="url(#workstream-loop-arrow)"
          stroke={stroke}
          strokeWidth="1.4"
        />
        <g>
          <title>{`Review loop — ${rounds} of ${cap} rework rounds used${verdict ? ` · latest verdict: ${verdict.replaceAll("_", " ")}` : ""}`}</title>
          <rect
            fill="#0d1117"
            height={15}
            rx="7"
            stroke={stroke}
            strokeWidth="1"
            width={40}
            x={badge.x - 20}
            y={badge.y - 7.5}
          />
          <text fill={stroke} fontSize="9" textAnchor="middle" x={badge.x} y={badge.y + 3}>
            {`⟲ ${rounds}/${cap}`}
          </text>
        </g>
      </g>
    );
  }
  if (edge.kind === "spine") {
    return (
      <line
        className="ws-graph-edge"
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
    const midX = (edge.x1 + edge.x2) / 2;
    return (
      <path
        className="ws-graph-edge"
        opacity={opacity}
        d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`}
        fill="none"
        markerEnd="url(#workstream-arrow)"
        stroke={FORK_STROKE}
        strokeWidth="1.4"
      />
    );
  }
  // A cross-wave dependency inversion carries orthogonal waypoints (routed
  // through a clear channel); a within-wave dep is a plain forward spline.
  const midX = (edge.x1 + edge.x2) / 2;
  const d = edge.points
    ? roundedPath(edge.points)
    : `M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`;
  return (
    <path
      className="ws-graph-edge"
      opacity={opacity}
      d={d}
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
// A backward consult (target left of / above the asker) carries orthogonal
// waypoints so it routes through a gutter instead of slicing a node.
function ConsultGraphEdge({
  edge,
  onOpenDispatch,
  dimmed,
}: {
  readonly edge: ConsultEdge;
  readonly onOpenDispatch: (
    threadId: ThreadId,
    anchorAtIso: string,
    expandConsultTargetId?: ThreadId,
  ) => void;
  readonly dimmed: boolean;
}) {
  const midX = (edge.x1 + edge.x2) / 2;
  const midY = (edge.y1 + edge.y2) / 2;
  // Count badge rides the straight routed segment (carried on the edge) for a
  // back-edge, or the endpoint midpoint for a forward spline.
  const badge = edge.badge ?? { x: midX, y: midY };
  const open = () => onOpenDispatch(edge.askerId, edge.anchorAtIso, edge.targetThreadId);
  const d = edge.points
    ? roundedPath(edge.points)
    : `M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`;
  return (
    <g
      className="ws-graph-consult-edge cursor-pointer outline-none"
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
      {/* Invisible fat hit-target so the thin dotted line is easy to click. */}
      <path d={d} fill="none" stroke="transparent" strokeWidth="10" />
      <path
        className="ws-focus-ring"
        d={d}
        fill="none"
        stroke="#38bdf8"
        strokeWidth="3"
        strokeOpacity="0.8"
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
            fill="#0d1117"
            height={15}
            rx="7"
            stroke={CONSULT_STROKE}
            strokeWidth="1"
            width={34}
            x={badge.x - 17}
            y={badge.y - 7.5}
          />
          <text fill={CONSULT_STROKE} fontSize="9" textAnchor="middle" x={badge.x} y={badge.y + 3}>
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
  dimmed,
}: {
  readonly node: Extract<LaidNode, { kind: "bridge" }>;
  readonly onOpenDispatch: (orchestratorId: ThreadId, anchorAtIso: string) => void;
  readonly dimmed: boolean;
}) {
  const open = () => onOpenDispatch(node.orchestratorId, node.anchorAtIso);
  return (
    <g
      className="ws-graph-node ws-graph-bridge cursor-pointer"
      opacity={dimmed ? FADE_OPACITY : 1}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      role="button"
      aria-label={`Jump to where wave ${node.waveIndex} was dispatched`}
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
      <FocusRing x={node.x} y={node.y} w={node.w} h={node.h} rx={11} />
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
  dimmed,
  onOpenThread,
  onOpenHistory,
  onNodeContextMenu,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
  onFocusStart,
  externalConsult,
}: {
  readonly node: Extract<LaidNode, { kind: "thread" }>;
  readonly threadById: ChildIndex;
  readonly dimmed: boolean;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
  readonly onOpenHistory: (thread: SidebarThreadSummary) => void;
  readonly onNodeContextMenu: (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => void;
  readonly onHoverStart: (thread: SidebarThreadSummary) => void;
  readonly onHoverMove: (event: { clientX: number; clientY: number }) => void;
  readonly onHoverEnd: () => void;
  readonly onFocusStart: (thread: SidebarThreadSummary, el: Element) => void;
  readonly externalConsult: ExternalConsult | undefined;
}) {
  // The laid-out node carries a STRUCTURAL snapshot (layout is memoised on a key
  // that excludes status), so resolve the live summary for status/labels — else
  // a lane/attention change wouldn't recolour the node until the graph re-lays.
  const thread = threadById.get(node.thread.id) ?? node.thread;
  const status = getThreadStatus(thread, threadById);
  const verdictChip = getVerdictChip(thread);
  const stateWord = getNodeStateWord(thread, threadById);
  const attentionPulse = getAttentionPulse(thread);
  const fanInBadge = getFanInBadge(thread);
  // Recession (design D): terminal cards dim so the live front reads first. The
  // hover highlight overrides this — a lit terminal node returns to full, a
  // faded one recedes further.
  const recede = status.column === "done" || status.column === "cancelled";
  const cardOpacity = dimmed ? FADE_OPACITY : recede ? RECEDE_OPACITY : 1;
  // Bottom-right badge row: every relationship badge (fork, fan-in, consult)
  // left-packs into the same corner.
  const forkBadgeX = node.x + node.w - 12;
  const fanInBadgeX = forkBadgeX - (thread.forkFromThreadId ? 20 : 0);
  const consultBadgeX = fanInBadgeX - (fanInBadge ? 20 : 0);
  // Metrics band for running/yielded nodes (⚒ tools · age). Null for every
  // other state — not-yet-run stays clean, terminal recedes. The live pulse
  // rides in the header strip beside the state word.
  const footer = getNodeFooter(thread, status.column);
  const titleLines = wrapLabel(thread.title, 24, 2);
  const open = () => onOpenThread(thread);
  // Right-click / keyboard menu key → the state-aware context menu (the ⓘ's
  // replacement). Cancel the hover card first so the facts never sit under it.
  const openMenu = (position: { x: number; y: number }) => {
    onHoverEnd();
    onNodeContextMenu(thread, position);
  };
  // Middle-click → open (or switch) the history drawer directly, the one-gesture
  // shortcut for the frequent "view history" action that otherwise needs the
  // right-click menu. Because the drawer target is panel state, middle-clicking
  // a different node just re-points it — switching histories without first
  // clicking into the graph to reselect.
  const openHistory = () => {
    onHoverEnd();
    onOpenHistory(thread);
  };
  const roleLabel = getRoleLabel(thread);
  return (
    // Container only (role=group). A single focusable open-button sits inside;
    // secondary actions live in the right-click context menu (no sibling ⓘ).
    // Pointer hover drives the facts card + dependency highlight. The
    // contextmenu handler is on the OUTER group so pills/badges are in the hit
    // area; preventDefault suppresses the native menu and stopPropagation keeps
    // the SVG canvas from ever seeing it (bridge nodes/canvas keep the native
    // menu — the affordance is thread-node-only).
    <g
      className="ws-graph-node"
      role="group"
      aria-label={`${roleLabel} ${thread.title}`}
      onMouseEnter={() => onHoverStart(thread)}
      onMouseMove={(event) => onHoverMove(event)}
      onMouseLeave={onHoverEnd}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
      // Middle button: suppress the browser's autoscroll on mousedown, then open
      // the history drawer on the aux-click. Kept on the OUTER group so the whole
      // card (pills/badges included) is the hit area, mirroring the contextmenu.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        openHistory();
      }}
    >
      {/* Primary affordance: open the thread. Keyboard focus mirrors hover. */}
      <g
        className="ws-graph-open cursor-pointer"
        role="button"
        aria-label={`Open thread ${thread.title}`}
        tabIndex={0}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            // Standard keyboard context-menu gesture: anchor the menu to the
            // node's own rect (bottom-centre) so keyboard users reach every
            // secondary action the removed ⓘ never exposed.
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({ x: rect.left + rect.width / 2, y: rect.bottom });
          }
        }}
        onFocus={(event) => onFocusStart(thread, event.currentTarget)}
        onBlur={onHoverEnd}
      >
        <FocusRing x={node.x} y={node.y} w={node.w} h={node.h} rx={10} />
        {/* Card visuals recede/fade as a unit; the button hit area stays crisp. */}
        <g opacity={cardOpacity}>
          <rect
            fill={status.graphFill}
            height={node.h}
            rx="10"
            stroke={status.graphStroke}
            strokeWidth={1.4}
            width={node.w}
            x={node.x}
            y={node.y}
          />
          {attentionPulse ? (
            // Attention overlay ring in the flag's colour, pulsing to pull the eye
            // to a node that needs a human — more than the board badge alone.
            <rect
              className="ws-attention-pulse"
              fill="none"
              height={node.h}
              pointerEvents="none"
              rx="10"
              stroke={attentionPulse.stroke}
              width={node.w}
              x={node.x}
              y={node.y}
            >
              <title>{attentionPulse.label}</title>
            </rect>
          ) : null}
          {/* Header strip (design C2): a stronger band of the status tint over
              the card fill, carrying ROLE · live pulse · the one worded state.
              Rounded top corners matching the card radius, squared bottom. */}
          <path
            d={`M ${node.x + 10} ${node.y} H ${node.x + node.w - 10} A 10 10 0 0 1 ${node.x + node.w} ${node.y + 10} V ${node.y + STRIP_H} H ${node.x} V ${node.y + 10} A 10 10 0 0 1 ${node.x + 10} ${node.y} Z`}
            fill={status.graphStroke}
            fillOpacity="0.16"
          />
          <text
            fill={status.graphStroke}
            fontSize="8"
            fontWeight="600"
            letterSpacing="0.06em"
            x={node.x + 10}
            y={node.y + 13.5}
          >
            {truncateLabel(roleLabel, 11).toUpperCase()}
          </text>
          {footer?.live ? (
            <circle
              className="ws-footer-live"
              cx={node.x + node.w - 16 - stateWord.length * 4.4}
              cy={node.y + 10.5}
              r={2.6}
              fill={status.graphStroke}
            />
          ) : null}
          <text
            fill={status.graphStroke}
            fontSize="8"
            textAnchor="end"
            x={node.x + node.w - 10}
            y={node.y + 13.5}
          >
            {truncateLabel(stateWord, 20)}
          </text>
          {/* Two-line wrapped title — the identity signal gets the whole body. */}
          <text fill="rgba(255,255,255,0.92)" fontSize="11" fontWeight="600">
            <tspan x={node.x + 10} y={node.y + 35}>
              {titleLines[0] ?? ""}
            </tspan>
            {titleLines[1] !== undefined ? (
              <tspan x={node.x + 10} y={node.y + 48}>
                {titleLines[1]}
              </tspan>
            ) : null}
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
          {thread.forkFromThreadId ? (
            // Thread fork: a distinct “forked from” glyph on the node (the source is
            // often a root outside this workstream graph, so a badge reads more
            // reliably than an edge). Hover names the source thread.
            <g>
              <title>{`Forked from ${
                threadById.get(thread.forkFromThreadId)?.title ?? thread.forkFromThreadId
              }`}</title>
              <circle
                cx={node.x + node.w - 12}
                cy={node.y + node.h - 12}
                fill="#0d1117"
                r="8"
                stroke={FORKED_FROM_STROKE}
                strokeWidth="1"
              />
              <text
                fill={FORKED_FROM_STROKE}
                fontSize="10"
                textAnchor="middle"
                x={forkBadgeX}
                y={node.y + node.h - 8.5}
              >
                ⑂
              </text>
            </g>
          ) : null}
          {fanInBadge ? (
            // Fan-in settlement of an isolated child's branch, in the same
            // bottom-right slot pattern as the ⑂ fork-from badge; nudged left when
            // they share the corner. Colour matches the card's fan-in chip.
            <g>
              <title>{`Fan-in: ${fanInBadge.label}`}</title>
              <circle
                cx={fanInBadgeX}
                cy={node.y + node.h - 12}
                fill="#0d1117"
                r="8"
                stroke={fanInBadge.stroke}
                strokeWidth="1"
              />
              <text
                fill={fanInBadge.stroke}
                fontSize="9"
                textAnchor="middle"
                x={fanInBadgeX}
                y={node.y + node.h - 8.5}
              >
                {fanInBadge.glyph}
              </text>
            </g>
          ) : null}
          {externalConsult ? (
            // Out-of-tree consults have no node to point at, so annotate the asker
            // with a teal consult glyph + count; the hover names the external targets.
            <g>
              <title>{`Consulted outside this graph: ${externalConsult.targetTitles.join(", ")}`}</title>
              <circle
                cx={consultBadgeX}
                cy={node.y + node.h - 12}
                fill="#0d1117"
                r="8"
                stroke={CONSULT_STROKE}
                strokeWidth="1"
              />
              <text
                fill={CONSULT_STROKE}
                fontSize="9"
                textAnchor="middle"
                x={consultBadgeX}
                y={node.y + node.h - 8.5}
              >
                {externalConsult.count > 9 ? "9+" : externalConsult.count}
              </text>
            </g>
          ) : null}
          {footer ? (
            // Metrics band: ⚒ tools · age in its own bottom slot (design C2).
            <text
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fontSize={8.5}
              fill="rgba(255,255,255,0.55)"
              pointerEvents="none"
              x={node.x + 10}
              y={node.y + node.h - 8}
            >
              {footer.toolLabel ? (
                <>
                  <tspan>{`⚒ ${footer.toolLabel} `}</tspan>
                  <tspan fill="rgba(255,255,255,0.25)">· </tspan>
                </>
              ) : null}
              <tspan>{footer.age}</tspan>
            </text>
          ) : null}
        </g>
      </g>
    </g>
  );
}

/** A keyboard-focus outline for an SVG affordance, shown only on `:focus-visible`
 * (driven by the `.ws-focus-ring` rules in the graph style block). */
function FocusRing({
  x,
  y,
  w,
  h,
  rx,
}: {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rx: number;
}) {
  return (
    <rect
      className="ws-focus-ring"
      x={x - 3}
      y={y - 3}
      width={w + 6}
      height={h + 6}
      rx={rx + 2}
      fill="none"
      stroke="#38bdf8"
      strokeWidth="2"
      pointerEvents="none"
    />
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
      className="rounded-md border border-white/10 bg-black/40 p-1.5 text-white/55 outline-none backdrop-blur transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-sky-400/70"
    >
      {children}
    </button>
  );
}
