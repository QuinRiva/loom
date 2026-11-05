// Read-only fork-join graph of dispatch episodes: the orchestrator recurs as one bridge node
// per wave (the children of one (parent, spawnGeneration)), children sit in dependency columns,
// and `blockedBy` draws as dashed cross-edges. Position encodes dispatch order; status is
// colour only (theme tokens). No animation loops.

import type { WorkstreamRollup } from "@t3tools/client-runtime/state/loom/rollup";
import type { ThreadId } from "@t3tools/contracts";
import { GitForkIcon, MaximizeIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  computeForkJoinLayout,
  computeForkJoinViewBox,
  type ConsultEdge,
  deriveConsultOverlay,
  deriveQueryOverlay,
  type ExternalConsult,
  type LaidEdge,
  type LaidNode,
  NODE_H,
  NODE_W,
  roundedPath,
  type ViewBox,
} from "../lib/forkJoinLayout";
import {
  COLUMN_LABELS,
  COLUMN_ORDER,
  COLUMN_STYLES,
  type ConversationAnchor,
  formatCompactAge,
  type StatusShape,
  getGateLoopCap,
  formatStepAge,
  getNodeStateWord,
  getNodeStripLabel,
  getRoleLabel,
  getStep,
  getVerdictChip,
  isRunning,
  isReceded,
  legibleHue,
  nodeAttentionOf,
  nodeStyleOf,
  TONE_COLORS,
  truncateLabel,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
  wrapLabel,
} from "../lib/workstreamPresentation";
import { useNowMinute } from "../hooks/useNowMinute";
import { observeResize } from "../lib/observeResize";
import { useStableCallback } from "../hooks/useStableCallback";
import { StatusDot } from "../loom/StatusDot";
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
const QUERY_STROKE = "var(--color-primary)";
// Done/cancelled cards recede so the live front reads first: their border and
// tint fade into the canvas while their text stays at full contrast.
const RECEDE_OPACITY = 0.42;
// A not-started node's border follows its legend dot: ring dashed, target (waiting) dotted.
const DASH = { dot: undefined, ring: "4 3", target: "1.5 2.5" } as const;
// Small grey text on a tinted card (`--graph-meta`, darker than muted in light mode).
const CARD_META_FILL = "var(--graph-meta)";
const FADE_OPACITY = 0.1;
const STRIP_H = 22;
const HOVER_DELAY_MS = 300;
const FACTS_W = 300;
// A keyboard-focus outline shown only while its group has focus-visible.
const FOCUS_RING_CLASS = "opacity-0 group-focus-visible:opacity-100";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// Semantic zoom: what a card shows is keyed to the rendered scale (screen px per layout unit).
// Below Full every label is counter-scaled to a fixed screen size, so none renders under 11px.
type DetailTier = "full" | "compact" | "minimal";
interface Detail {
  readonly tier: DetailTier;
  /** Layout units per screen pixel: a label `n` px tall is `n * k` units. */
  readonly k: number;
}
const LABEL_PX = 11;
const TITLE_PX = 12;
const BAND_PX = 17; // compact role row: an 11px label with 3px above and below
const LINE_PX = 14.5; // a 12px title line's pitch
const PAD_PX = 4;
// Full's 12-unit title renders at 11px from here (its 9.5-unit strip at 8.7px, as Full always has).
const FULL_MIN_SCALE = LABEL_PX / 12;
// The 78-unit card holds the role row and one title line (35.5px) from here; the seed fits at 0.52.
const COMPACT_MIN_SCALE = (BAND_PX + LINE_PX + PAD_PX) / NODE_H;
const FULL_DETAIL: Detail = { tier: "full", k: 1 };
// A height-bound graph widens its cards into the panel's spare width so a title reads at fit (the
// seed's go from ~10 to ~25 characters); capped at twice the default, past which Full is mostly empty.
const MAX_NODE_W = 2 * NODE_W;
const NODE_W_STEP = 16; // a resize re-lays the graph once per 16-unit step, not per pixel

const MAX_SVG_VH = 60;
/** The panel's room for the SVG: its width, and its height cap. */
interface PanelBox {
  readonly w: number;
  readonly maxH: number;
}

/** The fit-all box at the default card width, and how its width grows per unit of card width. */
function probeCardWidth(
  threads: ReadonlyArray<WorkstreamNode>,
  satelliteCounts: ReadonlyMap<ThreadId, number>,
) {
  const at = (nodeW: number) => {
    const { nodes, edges } = computeForkJoinLayout(threads, satelliteCounts, nodeW);
    return computeForkJoinViewBox(nodes, edges);
  };
  const narrow = at(NODE_W);
  return { ...narrow, slope: (at(MAX_NODE_W).w - narrow.w) / (MAX_NODE_W - NODE_W) };
}

/** The card width at which the fit-all box takes the panel's aspect, so no width goes unused. */
function cardWidthFor(probe: ReturnType<typeof probeCardWidth>, box: PanelBox | null) {
  if (!box || box.maxH <= 0 || probe.slope <= 0) return NODE_W;
  const grow = ((probe.h * box.w) / box.maxH - probe.w) / probe.slope;
  return clamp(NODE_W + Math.floor(grow / NODE_W_STEP) * NODE_W_STEP, NODE_W, MAX_NODE_W);
}

function detailOf(scale: number): Detail {
  if (!(scale > 0)) return FULL_DETAIL;
  // Floored to 1/16-octave steps (at most 4.4% under the true scale), so a label renders at or
  // just above its size and the cards re-render only when a step is crossed.
  const s = 2 ** (Math.floor(Math.log2(scale) * 16) / 16);
  return {
    tier: s >= FULL_MIN_SCALE ? "full" : s >= COMPACT_MIN_SCALE ? "compact" : "minimal",
    k: 1 / s,
  };
}

// Text fits are memoised by (text, width, size): a pan or zoom re-renders every card, and an
// unchanged label must cost no canvas measuring. Bounded by clearing; fonts loading late clear too.
const FIT_CACHE_MAX = 4000;
const widthCache = new Map<string, number>();
const fitCache = new Map<string, string | null>();
const wrapCache = new Map<string, ReadonlyArray<string>>();
function memo<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (cache.size >= FIT_CACHE_MAX) cache.clear();
  const value = compute();
  cache.set(key, value);
  return value;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
let measureFamily = "";
/** A label's rendered width in px in the app's UI face (a 0.6em estimate without canvas). */
function labelWidth(text: string, px: number, weight: number) {
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
    measureFamily = getComputedStyle(document.body).fontFamily;
    document.fonts?.addEventListener("loadingdone", () => {
      for (const cache of [widthCache, fitCache, wrapCache]) cache.clear();
    });
  }
  const ctx = measureCtx;
  if (!ctx) return text.length * px * 0.6;
  return memo(widthCache, `${weight}|${px}|${text}`, () => {
    ctx.font = `${weight} ${px}px ${measureFamily}`;
    return ctx.measureText(text).width;
  });
}

/** `text` whole if it fits `maxPx`, else its longest prefix with an ellipsis, else null. */
function fitLabel(text: string, maxPx: number, px: number, weight = 400): string | null {
  return memo(fitCache, `${weight}|${px}|${maxPx}|${text}`, () => {
    if (labelWidth(text, px, weight) <= maxPx) return text;
    let lo = 0;
    let hi = text.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (labelWidth(`${text.slice(0, mid).trimEnd()}…`, px, weight) <= maxPx) lo = mid;
      else hi = mid - 1;
    }
    return lo === 0 ? null : `${text.slice(0, lo).trimEnd()}…`;
  });
}

/** Word-wraps `text` into at most `maxLines` lines of `maxPx`; the last line truncates. */
function wrapToWidth(text: string, maxPx: number, px: number, weight: number, maxLines: number) {
  return memo(wrapCache, `${weight}|${px}|${maxPx}|${maxLines}|${text}`, () => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let next = 0;
    while (next < words.length && lines.length < maxLines - 1) {
      let line = words[next]!;
      let end = next + 1;
      while (end < words.length && labelWidth(`${line} ${words[end]}`, px, weight) <= maxPx)
        line += ` ${words[end++]}`;
      if (labelWidth(line, px, weight) > maxPx) break;
      lines.push(line);
      next = end;
    }
    const last =
      next < words.length ? fitLabel(words.slice(next).join(" "), maxPx, px, weight) : null;
    return last ? [...lines, last] : lines;
  });
}

/**
 * The first candidate that fits whole, else the last one truncated. Digits measure as `0`, so
 * siblings that differ only by a number (`Wave 1`, `Wave 2`) choose alike.
 */
const firstFit = (candidates: ReadonlyArray<string>, maxPx: number, px: number, weight = 400) =>
  candidates.find((text) => labelWidth(text.replace(/\d/g, "0"), px, weight) <= maxPx) ??
  fitLabel(candidates.at(-1) ?? "", maxPx, px, weight);

const capitalise = (value: string) => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

/** A card's top strip: rounded top corners, square bottom. */
const stripPath = (x: number, y: number, w: number, h: number) =>
  `M ${x + 10} ${y} H ${x + w - 10} A 10 10 0 0 1 ${x + w} ${y + 10} V ${y + h} H ${x} V ${y + 10} A 10 10 0 0 1 ${x + 10} ${y} Z`;

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

const savedGraphView = (viewKey: string) => useWorkstreamUiStore.getState().graphViewByKey[viewKey];

/**
 * The fork/join layout, recomputed only when the structure changes (lineage +
 * generation + deps + loop routes + order); loop rounds and status resolve
 * live at render, so a status-only shell update keeps the laid-out nodes.
 */
function useStructuralLayout(
  threads: ReadonlyArray<WorkstreamNode>,
  satellites: ReadonlyArray<WorkstreamNode>,
  box: PanelBox | null,
) {
  // A query satellite reserves room under its author's card, so how many hang
  // under each author is structure.
  const satelliteCounts = new Map<ThreadId, number>();
  for (const { forkFromThreadId: authorId } of satellites)
    if (authorId !== null) satelliteCounts.set(authorId, (satelliteCounts.get(authorId) ?? 0) + 1);
  const key = threads
    .map(
      (t) =>
        `${t.id}>${t.parentThreadId ?? ""}@${t.spawnGeneration ?? ""}#${t.createdAt}:${t.blockedBy.join(",")}~${t.routes
          .filter((route) => route.kind === "loop")
          .map((route) => route.to ?? "")
          .join(",")}`,
    )
    .join("|")
    .concat("|sat:", [...satelliteCounts].map(([id, count]) => `${id}*${count}`).join(","));
  const [state, setState] = useState(() => {
    const probe = probeCardWidth(threads, satelliteCounts);
    const nodeW = cardWidthFor(probe, box);
    return { key, probe, nodeW, layout: computeForkJoinLayout(threads, satelliteCounts, nodeW) };
  });
  const probe = state.key === key ? state.probe : probeCardWidth(threads, satelliteCounts);
  const nodeW = cardWidthFor(probe, box);
  if (state.key === key && state.nodeW === nodeW) return state.layout;
  const layout = computeForkJoinLayout(threads, satelliteCounts, nodeW);
  setState({ key, probe, nodeW, layout });
  return layout;
}

/**
 * The laid-out graph, the live consult overlay on it, and the fit-all view box.
 * Kept in one hook so no later hook call splits the compiler's cache for them:
 * the view box must keep its identity, or the re-fit effect loops.
 */
function useGraphGeometry(
  threads: ReadonlyArray<WorkstreamNode>,
  satellites: ReadonlyArray<WorkstreamNode>,
  byId: WorkstreamNodeIndex,
  box: PanelBox | null,
) {
  const { nodes, edges } = useStructuralLayout(threads, satellites, box);
  const queryOverlay = deriveQueryOverlay(nodes, satellites);
  // A query thread's consult of its live author draws like any other card's.
  const consultOverlay = deriveConsultOverlay([...nodes, ...queryOverlay.nodes], byId, edges);
  return {
    nodes,
    edges,
    queryOverlay,
    consultOverlay,
    base: computeForkJoinViewBox(
      [...nodes, ...queryOverlay.nodes],
      [...edges, ...queryOverlay.edges],
      consultOverlay.edges,
    ),
  };
}

export default function WorkstreamGraph({
  viewKey,
  nodes: threads,
  satellites,
  byId,
  rollupOf,
  titleOf,
  onOpenThread,
  onJump,
  onOpenTimeline,
  onNodeContextMenu,
}: {
  /** Scoped root-thread key identifying this orchestration's saved view. */
  readonly viewKey: string;
  /** The orchestration: the root and every live descendant. */
  readonly nodes: ReadonlyArray<WorkstreamNode>;
  /** Query threads (live and archived) forked from a member of `nodes`: drawn
   * beside their author, outside the structure. */
  readonly satellites: ReadonlyArray<WorkstreamNode>;
  readonly byId: WorkstreamNodeIndex;
  readonly rollupOf: (threadId: ThreadId) => WorkstreamRollup | null;
  readonly titleOf: (threadId: ThreadId) => string;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Open a thread scrolled to an anchored moment (loom/conversationJump). */
  readonly onJump: (anchor: ConversationAnchor) => void;
  readonly onOpenTimeline: (node: WorkstreamNode) => void;
  readonly onNodeContextMenu: (node: WorkstreamNode, position: { x: number; y: number }) => void;
}) {
  // The SVG's rendered size and the panel's height cap: the first keys the cards' semantic zoom,
  // the second (with the width) how wide the cards are laid.
  const [svgSize, setSvgSize] = useState<{ w: number; h: number; maxH: number } | null>(null);
  const { nodes, edges, queryOverlay, consultOverlay, base } = useGraphGeometry(
    threads,
    satellites,
    byId,
    svgSize,
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const factsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; vb: ViewBox } | null>(null);
  // Session-scoped saved view: returning to this orchestration restores the
  // zoom/pan the user left; Reset snaps back to fit-all.
  const setGraphView = useWorkstreamUiStore((store) => store.setGraphView);
  const [viewBox, setViewBox] = useState<ViewBox>(() => savedGraphView(viewKey)?.viewBox ?? base);
  const [adjusted, setAdjusted] = useState(() => savedGraphView(viewKey)?.adjusted ?? false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoveredId, setHoveredId] = useState<ThreadId | null>(null);
  const hovered = hoveredId === null ? undefined : byId.get(hoveredId);
  const detail = detailOf(
    svgSize ? Math.min(svgSize.w / viewBox.w, svgSize.h / viewBox.h) : Number.NaN,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the SVG's rendered size, which keys the cards' semantic zoom
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const { width: w, height: h } = svg.getBoundingClientRect();
      const maxH = (window.innerHeight * MAX_SVG_VH) / 100;
      setSvgSize((prev) =>
        prev?.w === w && prev.h === h && prev.maxH === maxH ? prev : { w, h, maxH },
      );
    };
    measure();
    const stopObserving = observeResize(svg, measure);
    window.addEventListener("resize", measure);
    return () => {
      stopObserving();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-fits a view the user has not zoomed or panned to the new geometry
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A structural change re-fits a view the user has not zoomed or panned; once they have, viewBox is theirs.
    if (!adjusted) setViewBox(base);
  }, [base, adjusted]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the view to the session store so returning to this orchestration restores it
  useEffect(() => {
    setGraphView(viewKey, { viewBox, adjusted });
  }, [setGraphView, viewKey, viewBox, adjusted]);

  // The hovered node plus its structural and consult neighbours stay lit.
  const litKeys =
    hoveredId === null
      ? null
      : new Set<string>([
          hoveredId,
          ...[...edges, ...queryOverlay.edges].flatMap((edge) =>
            edge.fromKey === hoveredId || edge.toKey === hoveredId
              ? [edge.fromKey, edge.toKey]
              : [],
          ),
          ...consultOverlay.edges.flatMap((edge) =>
            edge.askerId === hoveredId || edge.targetThreadId === hoveredId
              ? [edge.askerId, edge.targetThreadId]
              : [],
          ),
        ]);

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
  const positionFacts = useStableCallback((event: { clientX: number; clientY: number }) => {
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
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending hover timer on unmount
  useEffect(
    () => () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    },
    [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the facts card in the DOM from the pointer or focus position before paint
  useLayoutEffect(() => {
    if (hoveredId === null) return;
    const at = focusPosRef.current ?? pointerPosRef.current;
    if (at) positionFacts(at);
    focusPosRef.current = null;
  }, [hoveredId, positionFacts, focusPosRef, pointerPosRef]);

  // Zoom about a client-space anchor (wheel cursor); buttons zoom the centre.
  const zoomBy = useStableCallback((factor: number, client?: { x: number; y: number }) => {
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
  });

  const resetView = () => {
    setAdjusted(false);
    setViewBox(base);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a non-passive wheel listener, which React's onWheel cannot register, zooms the SVG
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 0.88 : 1 / 0.88, { x: event.clientX, y: event.clientY });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

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
          style={{ aspectRatio: `${base.w} / ${base.h}`, maxHeight: `${MAX_SVG_VH}vh` }}
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
          {[...edges, ...queryOverlay.edges].map((edge) => (
            <GraphEdge
              key={edge.key}
              edge={edge}
              byId={byId}
              full={detail.tier === "full"}
              dimmed={hoveredId !== null && edge.fromKey !== hoveredId && edge.toKey !== hoveredId}
            />
          ))}
          {consultOverlay.edges.map((edge) => (
            <ConsultGraphEdge
              key={edge.key}
              edge={edge}
              full={detail.tier === "full"}
              onJump={onJump}
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
                detail={detail}
                onOpenThread={onOpenThread}
                dimmed={litKeys !== null && !litKeys.has(node.key)}
              />
            ) : (
              <GraphNode
                key={node.key}
                laid={node}
                detail={detail}
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
                onJump={onJump}
              />
            ),
          )}
          {queryOverlay.nodes.map((node) => (
            <SatelliteNode
              key={node.key}
              laid={node}
              detail={detail}
              byId={byId}
              dimmed={litKeys !== null && !litKeys.has(node.thread.id)}
              onOpenThread={onOpenThread}
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
            />
          ))}
          {nodes.length === 0 && queryOverlay.nodes.length === 0 ? (
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
      {/* A left-aligned grid, so a narrow panel (or the open drawer) wraps it into columns. */}
      <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-x-4 gap-y-1 px-2 pb-1">
        {COLUMN_ORDER.map((column) => (
          <LegendItem
            key={column}
            swatch={<StatusDot className="size-2" {...COLUMN_STYLES[column]} />}
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
        {/* One swatch per stroke the loops on screen carry (each takes its gate's latest verdict tone). */}
        <LegendItem
          swatch={[
            ...new Set(
              edges.flatMap((edge) =>
                edge.kind === "loop"
                  ? [loopStrokeOf(edge.sourceId ? byId.get(edge.sourceId) : undefined)]
                  : [],
              ),
            ),
          ]
            .concat(edges.some((edge) => edge.kind === "loop") ? [] : [LOOP_STROKE])
            .map((stroke) => (
              <LineSwatch key={stroke} color={stroke} line="solid" />
            ))}
        >
          review loop ⟲
        </LegendItem>
        <LegendItem swatch={<LineSwatch color={CONSULT_STROKE} line="dotted" />}>
          consult
        </LegendItem>
        {queryOverlay.nodes.length > 0 ? (
          <LegendItem swatch={<LineSwatch color={QUERY_STROKE} line="dashed" />}>query</LegendItem>
        ) : null}
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
      className="inline-block h-0 w-4 border-t-2"
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
  full,
  dimmed,
}: {
  readonly edge: LaidEdge;
  readonly byId: WorkstreamNodeIndex;
  /** Below Full the round pill hides: the edge keeps its verdict colour, the cards their gate word. */
  readonly full: boolean;
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
    const target = byId.get(edge.toKey as ThreadId);
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
        <title>{`Review loop: ${rounds} of ${cap} rework rounds used${
          target?.pendingRework ? " · rework round open" : ""
        }${verdict ? ` · latest verdict: ${verdict.replaceAll("_", " ")}` : ""}`}</title>
        {full ? (
          <g>
            <rect
              fill="var(--color-background)"
              height={16}
              rx="8"
              stroke={stroke}
              strokeWidth="1"
              width={target?.pendingRework ? 56 : 44}
              x={badge.x - (target?.pendingRework ? 28 : 22)}
              y={badge.y - 8}
            />
            <text
              fill={legibleHue(stroke)}
              fontSize="10"
              textAnchor="middle"
              x={badge.x}
              y={badge.y + 3.5}
            >
              {`⟲ ${rounds}/${cap}${target?.pendingRework ? " ●" : ""}`}
            </text>
          </g>
        ) : null}
      </g>
    );
  }
  if (edge.kind === "query") {
    // A read-only fork of the author, not a dependency: no arrowhead.
    const satellite = byId.get(edge.toKey as ThreadId);
    return (
      <path
        opacity={dimmed ? FADE_OPACITY : satellite && isReceded(satellite) ? RECEDE_OPACITY : 1}
        d={roundedPath(edge.points ?? [])}
        fill="none"
        stroke={QUERY_STROKE}
        strokeDasharray="4 3"
        strokeWidth="1.3"
      />
    );
  }
  if (edge.kind === "spine" && edge.points) {
    return (
      <path
        opacity={opacity}
        d={roundedPath(edge.points)}
        fill="none"
        stroke={SPINE_STROKE}
        strokeWidth="2"
      />
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
// session. Clicking opens the asker at its latest consult of the target (any
// earlier ones are above it); a badge counts repeat consults.
function ConsultGraphEdge({
  edge,
  full,
  onJump,
  dimmed,
}: {
  readonly edge: ConsultEdge;
  readonly full: boolean;
  readonly onJump: (anchor: ConversationAnchor) => void;
  readonly dimmed: boolean;
}) {
  const midX = (edge.x1 + edge.x2) / 2;
  const badge = edge.badge ?? { x: midX, y: (edge.y1 + edge.y2) / 2 };
  const open = () => onJump({ threadId: edge.askerId, at: edge.anchorAtIso, consult: true });
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
      <title>{`Consulted: ${edge.preview}\nClick to open the latest consult`}</title>
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
      {full && edge.count > 1 ? (
        <g>
          <rect
            fill="var(--color-background)"
            height={16}
            rx="8"
            stroke={CONSULT_STROKE}
            strokeWidth="1"
            width={36}
            x={badge.x - 18}
            y={badge.y - 8}
          />
          <text
            fill={legibleHue(CONSULT_STROKE)}
            fontSize="10"
            textAnchor="middle"
            x={badge.x}
            y={badge.y + 3.5}
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
  detail,
  onOpenThread,
  dimmed,
}: {
  readonly node: Extract<LaidNode, { kind: "bridge" }>;
  readonly detail: Detail;
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
      {detail.tier === "full" ? (
        <>
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
            fill={CARD_META_FILL}
            fontSize="10"
            textAnchor="middle"
            x={node.x + node.w / 2}
            y={node.y + 34}
          >
            Orchestrator · wave {node.waveIndex}
          </text>
        </>
      ) : (
        <CompactBridgeBody node={node} k={detail.k} />
      )}
    </g>
  );
}

/** A bridge below Full: its title over its wave when both fit, else the wave alone. */
function CompactBridgeBody({
  node,
  k,
}: {
  readonly node: Extract<LaidNode, { kind: "bridge" }>;
  readonly k: number;
}) {
  const inner = node.w / k - 12;
  const height = node.h / k;
  const cx = node.x + node.w / 2;
  const wave = `Orchestrator · wave ${node.waveIndex}`;
  if (height >= PAD_PX * 2 + LINE_PX + LABEL_PX + 2) {
    const title = fitLabel(node.label, inner, TITLE_PX, 600);
    const meta = firstFit([wave, `Wave ${node.waveIndex}`], inner, LABEL_PX);
    const top = node.y + (node.h - (LINE_PX + LABEL_PX + 2) * k) / 2;
    return (
      <>
        <text
          className="fill-foreground/80"
          fontSize={TITLE_PX * k}
          fontWeight="600"
          textAnchor="middle"
          x={cx}
          y={top + 11 * k}
        >
          {title}
        </text>
        <text
          fill={CARD_META_FILL}
          fontSize={LABEL_PX * k}
          textAnchor="middle"
          x={cx}
          y={top + (LINE_PX + 10) * k}
        >
          {meta}
        </text>
      </>
    );
  }
  if (height < LABEL_PX + PAD_PX) return null;
  const label = firstFit(
    [wave, `Wave ${node.waveIndex}`, `${node.waveIndex}`],
    inner,
    LABEL_PX,
    600,
  );
  return (
    <text
      className="fill-foreground/80"
      fontSize={LABEL_PX * k}
      fontWeight="600"
      textAnchor="middle"
      x={cx}
      y={node.y + node.h / 2 + 4 * k}
    >
      {label}
    </text>
  );
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A query thread hung off its author: `? <document>` and its question and promotion counts. */
function SatelliteNode({
  laid,
  detail,
  byId,
  dimmed,
  onOpenThread,
  onContextMenu,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
  onFocusStart,
}: {
  readonly laid: Extract<LaidNode, { kind: "thread" }>;
  readonly detail: Detail;
  readonly byId: WorkstreamNodeIndex;
  readonly dimmed: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onContextMenu: (node: WorkstreamNode, position: { x: number; y: number }) => void;
  readonly onHoverStart: () => void;
  readonly onHoverMove: (event: { clientX: number; clientY: number }) => void;
  readonly onHoverEnd: () => void;
  readonly onFocusStart: (el: Element) => void;
}) {
  const node = byId.get(laid.thread.id) ?? laid.thread;
  const { x, y, w, h } = laid;
  const query = node.documentQuery;
  const label = `? ${query ? query.filePath.slice(query.filePath.lastIndexOf("/") + 1) : node.title}`;
  const counts = query
    ? `${plural(query.questions.length, "question")} · ${query.promotions.length} promoted`
    : "forking…";
  const { tier, k } = detail;
  const inner = w / k - 14;
  // Below Full: the label at 11px, the counts under it when the card has room for both.
  const lines =
    tier === "full"
      ? null
      : h / k >= PAD_PX * 2 + LINE_PX + LABEL_PX
        ? [firstFit([label, "?"], inner, LABEL_PX, 600), fitLabel(counts, inner, LABEL_PX)]
        : h / k >= LABEL_PX + PAD_PX
          ? [firstFit([label, "?"], inner, LABEL_PX, 600)]
          : [];
  return (
    <g
      data-graph-hit
      data-graph-query-satellite=""
      className="group cursor-pointer outline-none"
      role="button"
      aria-label={`Open query thread ${node.title}`}
      tabIndex={0}
      opacity={dimmed ? FADE_OPACITY : 1}
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
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(node, { x: event.clientX, y: event.clientY });
      }}
      onMouseEnter={onHoverStart}
      onMouseMove={onHoverMove}
      onMouseLeave={onHoverEnd}
      onFocus={(event) => onFocusStart(event.currentTarget)}
      onBlur={onHoverEnd}
    >
      <FocusRing x={x} y={y} w={w} h={h} rx={8} />
      <rect
        fill="var(--color-background)"
        height={h}
        rx="8"
        stroke={QUERY_STROKE}
        strokeDasharray="4 3"
        strokeOpacity={isReceded(node) ? RECEDE_OPACITY : 1}
        strokeWidth={1.3}
        width={w}
        x={x}
        y={y}
      />
      {lines === null ? (
        <>
          <text
            className={isReceded(node) ? "fill-muted-foreground" : "fill-foreground"}
            fontSize="11"
            fontWeight="600"
            x={x + 9}
            y={y + 16}
          >
            {truncateLabel(label, 20)}
          </text>
          <text className="fill-muted-foreground" fontSize="10" x={x + 9} y={y + 31}>
            {counts}
          </text>
        </>
      ) : (
        lines.map((line, index) => (
          <text
            key={index === 0 ? "label" : "counts"}
            className={
              index === 0 && !isReceded(node) ? "fill-foreground" : "fill-muted-foreground"
            }
            fontSize={LABEL_PX * k}
            fontWeight={index === 0 ? 600 : undefined}
            x={x + 7 * k}
            y={y + h / 2 + (4 + (index - (lines.length - 1) / 2) * (LINE_PX - 1)) * k}
          >
            {line}
          </text>
        ))
      )}
    </g>
  );
}

function CornerBadge({
  cx,
  cy,
  k = 1,
  stroke,
  title,
  children,
}: {
  cx: number;
  cy: number;
  /** Units per screen px below Full (the badge holds a fixed screen size); 1 at Full. */
  k?: number;
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
        r={8 * k}
        stroke={stroke}
        strokeWidth={k}
      />
      {typeof children === "object" ? (
        children
      ) : (
        // Full keeps its 10-unit digit; below it the digit holds 11px.
        <text
          fill={legibleHue(stroke)}
          fontSize={(k === 1 ? 10 : LABEL_PX) * k}
          textAnchor="middle"
          x={cx}
          y={cy + 3.6 * k}
        >
          {children}
        </text>
      )}
    </g>
  );
}

/** `StatusDot`'s shapes in SVG, so a card below Full reads against the legend's dots. */
function StatusGlyph({
  cx,
  cy,
  r,
  color,
  shape,
}: {
  cx: number;
  cy: number;
  r: number;
  color: string;
  shape: StatusShape;
}) {
  return shape === "dot" ? (
    <circle cx={cx} cy={cy} r={r} fill={color} />
  ) : (
    <>
      <circle cx={cx} cy={cy} r={r * 0.8} fill="none" stroke={color} strokeWidth={r * 0.4} />
      {shape === "target" ? <circle cx={cx} cy={cy} r={r * 0.4} fill={color} /> : null}
    </>
  );
}

/**
 * A card below Full, every label at a fixed screen size. Compact: a role row (state glyph, role,
 * and the state word when it fits) over the title in one or two lines as the card's height
 * allows. Minimal: one row of glyph, role and as much title as fits; the rest is on hover.
 */
function CompactCardBody({
  node,
  laid,
  detail,
  color,
  shape,
  stateWord,
  recede,
  badgesPx,
}: {
  readonly node: WorkstreamNode;
  readonly laid: Extract<LaidNode, { kind: "thread" }>;
  readonly detail: Detail;
  readonly color: string;
  readonly shape: StatusShape;
  readonly stateWord: string;
  readonly recede: boolean;
  /** Screen width the corner badges take from the role row. */
  readonly badgesPx: number;
}) {
  const { x, y, w, h } = laid;
  const { tier, k } = detail;
  const hue = legibleHue(color);
  const inner = w / k - 12;
  const height = h / k;
  const role = capitalise(getRoleLabel(node));
  if (tier === "minimal") {
    // One row: the glyph, the role, and as much of the title as the card's width leaves.
    const cy = y + h / 2;
    const label = height >= LABEL_PX + PAD_PX ? fitLabel(role, inner - 10.5, LABEL_PX, 600) : null;
    const titleRoom = inner - 16.5 - (label ? labelWidth(label, LABEL_PX, 600) : inner);
    const title = titleRoom >= 3 * LABEL_PX ? fitLabel(node.title, titleRoom, LABEL_PX, 600) : null;
    return (
      <>
        <StatusGlyph cx={x + 9.5 * k} cy={cy} r={3.5 * k} color={color} shape={shape} />
        {label ? (
          <text fontSize={LABEL_PX * k} fontWeight="600" x={x + 16.5 * k} y={cy + 3.8 * k}>
            <tspan fill={hue}>{label}</tspan>
            {title ? (
              <tspan className={recede ? "fill-muted-foreground" : "fill-foreground"} dx={6 * k}>
                {title}
              </tspan>
            ) : null}
          </text>
        ) : null}
      </>
    );
  }
  const roleRow = inner - badgesPx;
  const stateFits =
    10.5 + labelWidth(role, LABEL_PX, 600) + 8 + labelWidth(stateWord, LABEL_PX, 400) <= roleRow;
  const lines = wrapToWidth(
    node.title,
    inner,
    TITLE_PX,
    600,
    height >= BAND_PX + 2 * LINE_PX + PAD_PX ? 2 : 1,
  );
  const top = BAND_PX + (height - BAND_PX - lines.length * LINE_PX) / 2;
  return (
    <>
      <path
        d={stripPath(x, y, w, BAND_PX * k)}
        fill={color}
        fillOpacity={recede ? 0.16 * RECEDE_OPACITY : 0.16}
      />
      <StatusGlyph
        cx={x + 9.5 * k}
        cy={y + (BAND_PX / 2) * k}
        r={3.5 * k}
        color={color}
        shape={shape}
      />
      <text fill={hue} fontSize={LABEL_PX * k} fontWeight="600" x={x + 16.5 * k} y={y + 12.5 * k}>
        {stateFits ? role : fitLabel(role, roleRow - 10.5, LABEL_PX, 600)}
      </text>
      {stateFits ? (
        <text
          fill={hue}
          fontSize={LABEL_PX * k}
          textAnchor="end"
          x={x + w - (6 + badgesPx) * k}
          y={y + 12.5 * k}
        >
          {stateWord}
        </text>
      ) : null}
      <text
        className={recede ? "fill-muted-foreground" : "fill-foreground"}
        fontSize={TITLE_PX * k}
        fontWeight="600"
      >
        {lines.map((line, index) => (
          <tspan key={line} x={x + 6 * k} y={y + (top + 11 + index * LINE_PX) * k}>
            {line}
          </tspan>
        ))}
      </text>
    </>
  );
}

function GraphNode({
  laid,
  detail,
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
  onJump,
}: {
  readonly laid: Extract<LaidNode, { kind: "thread" }>;
  readonly detail: Detail;
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
  readonly onJump: (anchor: ConversationAnchor) => void;
}) {
  // The laid node is a structural snapshot; resolve the live one for status.
  const node = byId.get(laid.thread.id) ?? laid.thread;
  const { x, y, w, h } = laid;
  const { color, shape } = nodeStyleOf(node, byId);
  const verdict = getVerdictChip(node);
  const stateWord = getNodeStateWord(node, byId);
  const attention = nodeAttentionOf(node);
  const recede = node.column === "done" || node.column === "cancelled";
  const running = isRunning(node);
  // Ages and step durations tick on the shared minute clock (no per-node timer).
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const step = getStep(node, now);
  const stepAge = step && formatStepAge(step.since, now);
  // The footer's age ends left of the corner badges; both lines lift clear of a verdict pill.
  const footerEnd = x + w - 10 - (node.forkFromThreadId ? 20 : 0) - (externalConsult ? 20 : 0);
  const footerY = y + h - (verdict ? 11 : 8);
  // 22 characters on the default card; a widened card takes more per line.
  const titleLines = wrapLabel(node.title, Math.max(22, Math.floor((w - 20) / 6.9)), 2);
  const roleLabel = getRoleLabel(node);
  const { tier, k } = detail;
  const full = tier === "full";
  // Full sets its corner badges inside the card; below it they straddle the top border at a
  // fixed screen size, beside the role, and Minimal drops them.
  const badgeK = full ? 1 : k;
  const badgeY = full ? y + h - 12 : y;
  const forkBadgeX = x + w - 12 * badgeK;
  const consultBadgeX = forkBadgeX - (node.forkFromThreadId ? 20 * badgeK : 0);
  const showBadges = tier !== "minimal";
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
        <g opacity={dimmed ? FADE_OPACITY : 1}>
          <rect
            fill={
              recede
                ? "var(--color-muted)"
                : `color-mix(in srgb, ${color} 14%, var(--color-background))`
            }
            height={h}
            rx="10"
            stroke={color}
            strokeDasharray={DASH[shape]}
            strokeOpacity={recede ? RECEDE_OPACITY : 1}
            strokeWidth={1.4}
            width={w}
            x={x}
            y={y}
          />
          {attention ? (
            // Attention ring in its colour (static — no pulse).
            <rect
              fill="none"
              height={h + 5}
              pointerEvents="none"
              rx="12"
              stroke={attention.color}
              strokeWidth={2}
              width={w + 5}
              x={x - 2.5}
              y={y - 2.5}
            >
              <title>{attention.label}</title>
            </rect>
          ) : null}
          {full ? (
            <>
              <path
                d={stripPath(x, y, w, STRIP_H)}
                fill={color}
                fillOpacity={recede ? 0.16 * RECEDE_OPACITY : 0.16}
              />
              <text
                fill={legibleHue(color)}
                fontSize="9.5"
                fontWeight="600"
                x={x + 10}
                y={y + 14.5}
              >
                {getNodeStripLabel(node, stateWord)}
              </text>
              {running ? (
                <circle cx={x + w - 16 - stateWord.length * 5.2} cy={y + 11} r={2.8} fill={color} />
              ) : null}
              <text
                fill={legibleHue(color)}
                fontSize="9.5"
                textAnchor="end"
                x={x + w - 10}
                y={y + 14.5}
              >
                {stateWord}
              </text>
              <text
                className={recede ? "fill-muted-foreground" : "fill-foreground"}
                fontSize="12"
                fontWeight="600"
              >
                <tspan x={x + 10} y={y + 38}>
                  {titleLines[0] ?? ""}
                </tspan>
                {titleLines[1] !== undefined ? (
                  <tspan x={x + 10} y={y + 52}>
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
            </>
          ) : (
            <>
              <CompactCardBody
                node={node}
                laid={laid}
                detail={detail}
                color={color}
                shape={shape}
                stateWord={stateWord}
                recede={recede}
                badgesPx={
                  showBadges ? (node.forkFromThreadId ? 20 : 0) + (externalConsult ? 20 : 0) : 0
                }
              />
              {verdict ? (
                // The gate pill folds to a dot in its tone on the bottom border; the verdict on hover.
                <circle
                  cx={x + 14 * k}
                  cy={y + h}
                  fill={TONE_COLORS[verdict.tone]}
                  r={4.5 * k}
                  stroke="var(--color-background)"
                  strokeWidth={1.5 * k}
                >
                  <title>{verdict.label}</title>
                </circle>
              ) : null}
            </>
          )}
          {node.forkFromThreadId && showBadges ? (
            <CornerBadge
              cx={forkBadgeX}
              cy={badgeY}
              k={badgeK}
              stroke={FORKED_FROM_STROKE}
              title={`Forked from ${titleOf(node.forkFromThreadId)}`}
            >
              <GitForkIcon
                x={forkBadgeX - 5 * badgeK}
                y={badgeY - 5 * badgeK}
                width={10 * badgeK}
                height={10 * badgeK}
                color={legibleHue(FORKED_FROM_STROKE)}
              />
            </CornerBadge>
          ) : null}
          {full && node.column === "in_progress" ? (
            <g
              fill={CARD_META_FILL}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fontSize={9}
              pointerEvents="none"
            >
              <text x={x + 10} y={footerY}>
                {step ? truncateLabel(step.label, 15) : (node.activity ?? "idle")}
                {stepAge ? (
                  <>
                    {" · "}
                    <tspan
                      fill={step?.long ? legibleHue("var(--color-warning)") : undefined}
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
      {externalConsult && showBadges ? (
        <ExternalConsultBadge
          consult={externalConsult}
          cx={consultBadgeX}
          cy={badgeY}
          k={badgeK}
          opacity={dimmed ? FADE_OPACITY : 1}
          onOpen={() =>
            onJump({ threadId: node.id, at: externalConsult.anchorAtIso, consult: true })
          }
        />
      ) : null}
    </g>
  );
}

/**
 * The consults a card draws no edge for (to the root orchestrator, or outside
 * the graph). Its own button beside the card's, so a click lands on the latest
 * of them in the asker's chat rather than opening the thread at its end; the
 * consult card there links the target, and any earlier consults are above it.
 */
function ExternalConsultBadge({
  consult,
  cx,
  cy,
  k,
  opacity,
  onOpen,
}: {
  readonly consult: ExternalConsult;
  readonly cx: number;
  readonly cy: number;
  readonly k: number;
  readonly opacity: number;
  readonly onOpen: () => void;
}) {
  const title = [
    ...consult.targets.map(
      (target) =>
        `${target.orchestrator ? "Consulted the orchestrator" : "Consulted outside this graph"}: ${target.title}${target.count > 1 ? ` (×${target.count})` : ""}`,
    ),
    "Click to open the latest consult",
  ].join("\n");
  return (
    <g
      className="group cursor-pointer outline-none"
      opacity={opacity}
      role="button"
      aria-label={title}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <circle
        className={FOCUS_RING_CLASS}
        cx={cx}
        cy={cy}
        fill="none"
        r={11 * k}
        stroke="var(--color-ring)"
        strokeWidth="2"
      />
      <CornerBadge cx={cx} cy={cy} k={k} stroke={CONSULT_STROKE} title={title}>
        {consult.count > 9 ? "9+" : consult.count}
      </CornerBadge>
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
  const width = label.length * 5.4 + 10;
  return (
    <g>
      <rect
        fill={`color-mix(in srgb, ${stroke} 18%, var(--color-background))`}
        height={15}
        rx="7.5"
        stroke={stroke}
        strokeWidth="1"
        width={width}
        x={xEnd - width}
        y={yCenter - 7.5}
      />
      <text
        fill={legibleHue(stroke)}
        fontSize="9.5"
        textAnchor="middle"
        x={xEnd - width / 2}
        y={yCenter + 3.3}
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
