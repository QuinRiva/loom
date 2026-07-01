import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { CanvasTransform } from "../annotation/anchoring";
import type { PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { ScreenRead, type ScreenData, type ScreenFidelity, type WireframeSurface } from "./screen";

/**
 * Wave C2 \u2014 the spatial canvas. A `<DesignBoard>` establishes a board-unit
 * coordinate space; `<Section>` frames group artboards; each `<Artboard>` is a
 * positioned wireframe/design screen (rendered through {@link ScreenRead}, in the
 * LIVE DOM so annotation keeps ONE geometry model); `<Annotation>` is an authored
 * gutter note; `<Connector>` draws a flow line between two artboards.
 *
 * BOARD GEOMETRY. Board units map to pixels at ~2 units/pixel
 * ({@link CANVAS_BOARD_SCALE} = 0.5), the canonical transform the A1 anchoring
 * contract ({@link CanvasTransform}) and its `resolveCanvasAnchor` consume. The
 * `DesignBoard` PROVIDES the transform to its descendants (context) AND publishes
 * the scale on the DOM (`data-board-scale`) so the annotation overlay layer can
 * rebuild it from the element via {@link canvasTransformForElement} \u2014 the same
 * transform for authored layout and for free-floating review anchors.
 *
 * Node-pinned canvas annotations resolve through the `wireframe` branch (the
 * artboard is `[data-plan-block-type="wireframe"|"design"]`); only truly
 * free-floating board-space notes use the `canvas` coordinate branch.
 */

/** ~2 board-units per pixel (BuilderIO's canvas scale). */
export const CANVAS_BOARD_SCALE = 0.5;

/** The board\u2192pixel transform the canvas provides for `anchorKind:"canvas"`
 * resolution. Pixels are relative to the board surface's top-left (the same
 * space the authored overlays live in), so no page offset is needed. */
export function createCanvasTransform(scale: number = CANVAS_BOARD_SCALE): CanvasTransform {
  return {
    boardScale: scale,
    boardToPixel: ({ x, y }) => ({ x: x * scale, y: y * scale }),
  };
}

/** Rebuild the transform from a rendered `<DesignBoard>` element (reads
 * `data-board-scale`). This is how the annotation overlay obtains the transform
 * for a board without React context. */
export function canvasTransformForElement(board: Element): CanvasTransform {
  const scale = Number(board.getAttribute("data-board-scale"));
  return createCanvasTransform(Number.isFinite(scale) && scale > 0 ? scale : CANVAS_BOARD_SCALE);
}

const CanvasTransformContext = createContext<CanvasTransform>(createCanvasTransform());
const SURFACE_CLASS = "plan-canvas-surface";

/** Escape an id for a quoted attribute selector (connector/annotation targets). */
const escapeId = (id: string): string =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");

/** Rect of `[data-plan-block-id=id]` relative to the board surface, or null. */
function rectWithinSurface(
  surface: HTMLElement,
  id: string,
): { left: number; top: number; width: number; height: number } | null {
  let target: Element | null;
  try {
    target = surface.querySelector(`[data-plan-block-id="${escapeId(id)}"]`);
  } catch {
    return null;
  }
  if (!target) return null;
  const s = surface.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  return { left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height };
}

/* -------------------------------------------------------------------------- */
/* DesignBoard \u2014 coordinate space + transform provider                        */
/* -------------------------------------------------------------------------- */

export interface DesignBoardData {
  title?: string;
  /** Board extent (units) used as a *minimum* footprint; the board auto-grows to
   * contain its positioned children. */
  width?: number;
  height?: number;
}

export const designBoardSchema = z.object({
  title: z.string().max(300).optional(),
  width: z.number().min(0).max(20_000).optional(),
  height: z.number().min(0).max(20_000).optional(),
}) as unknown as z.ZodType<DesignBoardData>;

export function DesignBoardRead({ data, blockId, children }: PlanBlockReadProps<DesignBoardData>) {
  const transform = createCanvasTransform();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: (data.width ?? 0) * transform.boardScale,
    height: (data.height ?? 0) * transform.boardScale,
  });

  // Absolutely-positioned children don't contribute to the surface's scroll size,
  // so measure them and grow the surface to contain every artboard/frame/note.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const fit = () => {
      const base = surface.getBoundingClientRect();
      let maxRight = (data.width ?? 0) * transform.boardScale;
      let maxBottom = (data.height ?? 0) * transform.boardScale;
      for (const child of surface.querySelectorAll<HTMLElement>("[data-canvas-item]")) {
        const r = child.getBoundingClientRect();
        maxRight = Math.max(maxRight, r.right - base.left);
        maxBottom = Math.max(maxBottom, r.bottom - base.top);
      }
      setSize({ width: Math.ceil(maxRight) + 24, height: Math.ceil(maxBottom) + 24 });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [children, data.width, data.height, transform.boardScale]);

  return (
    <CanvasTransformContext.Provider value={transform}>
      <figure
        data-plan-block-id={blockId}
        data-plan-block-type="canvas"
        data-board-scale={transform.boardScale}
        className="plan-canvas my-6"
      >
        {data.title ? <figcaption className="plan-canvas-title">{data.title}</figcaption> : null}
        <div className="plan-canvas-scroll">
          <div
            ref={surfaceRef}
            className={SURFACE_CLASS}
            style={{ width: size.width || undefined, height: size.height || undefined }}
          >
            {children}
          </div>
        </div>
      </figure>
    </CanvasTransformContext.Provider>
  );
}

export const designBoardBlock: PlanBlock<DesignBoardData> = {
  schema: designBoardSchema,
  Read: DesignBoardRead,
  mdx: {
    tag: "DesignBoard",
    passChildren: true,
    toAttrs: (data) => ({ title: data.title, width: data.width, height: data.height }),
    fromAttrs: (attrs) =>
      ({
        title: attrs.string("title"),
        width: attrs.number("width"),
        height: attrs.number("height"),
      }) as DesignBoardData,
  },
};

/* -------------------------------------------------------------------------- */
/* Section \u2014 a labelled frame grouping artboards (visual only)                */
/* -------------------------------------------------------------------------- */

export interface SectionData {
  title?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const sectionSchema = z.object({
  title: z.string().max(300).optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().min(0).max(20_000),
  height: z.number().min(0).max(20_000),
}) as unknown as z.ZodType<SectionData>;

export function SectionRead({ data, children }: PlanBlockReadProps<SectionData>) {
  const { boardToPixel, boardScale } = useContext(CanvasTransformContext);
  const origin = boardToPixel({ x: data.x, y: data.y });
  // `display:contents` keeps this element out of layout so the frame box AND the
  // nested artboards all position against the DesignBoard surface (global board
  // coordinates), rather than nesting a second positioning context.
  return (
    <div className="plan-canvas-section" style={{ display: "contents" }}>
      <div
        data-canvas-item
        className="plan-canvas-section-frame"
        style={{
          position: "absolute",
          left: origin.x,
          top: origin.y,
          width: data.width * boardScale,
          height: data.height * boardScale,
        }}
      >
        {data.title ? <span className="plan-canvas-section-label">{data.title}</span> : null}
      </div>
      {children}
    </div>
  );
}

export const sectionBlock: PlanBlock<SectionData> = {
  schema: sectionSchema,
  Read: SectionRead,
  mdx: {
    tag: "Section",
    passChildren: true,
    toAttrs: (data) => ({
      title: data.title,
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height,
    }),
    fromAttrs: (attrs) =>
      ({
        title: attrs.string("title"),
        x: attrs.number("x") ?? 0,
        y: attrs.number("y") ?? 0,
        width: attrs.number("width") ?? 0,
        height: attrs.number("height") ?? 0,
      }) as SectionData,
  },
};

/* -------------------------------------------------------------------------- */
/* Artboard \u2014 a positioned wireframe/design screen                            */
/* -------------------------------------------------------------------------- */

export interface ArtboardData {
  x: number;
  y: number;
  surface: WireframeSurface;
  html: string;
  caption?: string;
  fidelity?: ScreenFidelity;
}

export const artboardSchema = z.object({
  x: z.number(),
  y: z.number(),
  surface: z.enum(["browser", "desktop", "mobile", "popover", "panel"]).default("browser"),
  html: z.string().max(200_000),
  caption: z.string().max(500).optional(),
  fidelity: z.enum(["wireframe", "design"]).optional(),
}) as unknown as z.ZodType<ArtboardData>;

export function ArtboardRead({ data, blockId }: PlanBlockReadProps<ArtboardData>) {
  const { boardToPixel } = useContext(CanvasTransformContext);
  const origin = boardToPixel({ x: data.x, y: data.y });
  const screen: ScreenData = {
    surface: data.surface,
    html: data.html,
    ...(data.caption !== undefined ? { caption: data.caption } : {}),
    ...(data.fidelity !== undefined ? { fidelity: data.fidelity } : {}),
  };
  // The positioned wrapper carries no annotation attributes; the inner ScreenRead
  // figure carries data-plan-block-type + data-plan-block-id + data-wf-node, so
  // node-pin anchoring resolves exactly as for a standalone <Screen>.
  return (
    <div
      data-canvas-item
      className="plan-canvas-artboard"
      style={{ position: "absolute", left: origin.x, top: origin.y }}
    >
      <ScreenRead data={screen} blockId={blockId} flow={false} />
    </div>
  );
}

export const artboardBlock: PlanBlock<ArtboardData> = {
  schema: artboardSchema,
  Read: ArtboardRead,
  mdx: {
    tag: "Artboard",
    toAttrs: (data) => ({
      x: data.x,
      y: data.y,
      surface: data.surface,
      html: data.html,
      caption: data.caption,
      fidelity: data.fidelity,
    }),
    fromAttrs: (attrs) =>
      ({
        x: attrs.number("x") ?? 0,
        y: attrs.number("y") ?? 0,
        surface: (attrs.string("surface") as WireframeSurface | undefined) ?? "browser",
        html: attrs.string("html") ?? "",
        caption: attrs.string("caption"),
        fidelity: attrs.string("fidelity") as ScreenFidelity | undefined,
      }) as ArtboardData,
  },
};

/* -------------------------------------------------------------------------- */
/* Annotation \u2014 an authored gutter note parked beside a target artboard       */
/* -------------------------------------------------------------------------- */

export type AnnotationPlacement = "left" | "right" | "top" | "bottom";

export interface AnnotationData {
  /** Artboard id to park beside (its `data-plan-block-id`). */
  targetId?: string;
  placement?: AnnotationPlacement;
  /** Free-floating board coordinates when there is no target. */
  x?: number;
  y?: number;
  /** Note body (MDX prose children). */
  text?: string;
}

export const annotationSchema = z.object({
  targetId: z.string().max(200).optional(),
  placement: z.enum(["left", "right", "top", "bottom"]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  text: z.string().max(4000).optional(),
}) as unknown as z.ZodType<AnnotationData>;

const ANNOTATION_GAP = 12;

export function AnnotationRead({ data, blockId, children }: PlanBlockReadProps<AnnotationData>) {
  const { boardToPixel } = useContext(CanvasTransformContext);
  const selfRef = useRef<HTMLDivElement>(null);
  const freePt =
    data.x !== undefined && data.y !== undefined ? boardToPixel({ x: data.x, y: data.y }) : null;
  const free = freePt ? { left: freePt.x, top: freePt.y } : null;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(free);

  useLayoutEffect(() => {
    const self = selfRef.current;
    const surface = self?.closest<HTMLElement>(`.${SURFACE_CLASS}`);
    if (!self || !surface) return;
    const place = () => {
      const target = data.targetId ? rectWithinSurface(surface, data.targetId) : null;
      if (!target) {
        if (free) setPos(free);
        return;
      }
      const w = self.offsetWidth;
      const h = self.offsetHeight;
      const placement = data.placement ?? "right";
      const spots: Record<AnnotationPlacement, { left: number; top: number }> = {
        right: { left: target.left + target.width + ANNOTATION_GAP, top: target.top },
        left: { left: target.left - w - ANNOTATION_GAP, top: target.top },
        top: { left: target.left, top: target.top - h - ANNOTATION_GAP },
        bottom: { left: target.left, top: target.top + target.height + ANNOTATION_GAP },
      };
      setPos(spots[placement]);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [data.targetId, data.placement, free?.left, free?.top]);

  return (
    <div
      ref={selfRef}
      data-canvas-item
      data-plan-block-id={blockId}
      data-plan-block-type="annotation"
      className="plan-canvas-annotation"
      style={{
        position: "absolute",
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {(children as ReactNode) ?? data.text}
    </div>
  );
}

export const annotationBlock: PlanBlock<AnnotationData> = {
  schema: annotationSchema,
  Read: AnnotationRead,
  mdx: {
    tag: "Annotation",
    childrenField: "text",
    toAttrs: (data) => ({
      targetId: data.targetId,
      placement: data.placement,
      x: data.x,
      y: data.y,
    }),
    fromAttrs: (attrs, children) =>
      ({
        targetId: attrs.string("targetId"),
        placement: attrs.string("placement") as AnnotationPlacement | undefined,
        x: attrs.number("x"),
        y: attrs.number("y"),
        text: children,
      }) as AnnotationData,
  },
};

/* -------------------------------------------------------------------------- */
/* Connector \u2014 a flow line between two artboards                              */
/* -------------------------------------------------------------------------- */

export interface ConnectorData {
  from: string;
  to: string;
  label?: string;
}

export const connectorSchema = z.object({
  from: z.string().min(1).max(200),
  to: z.string().min(1).max(200),
  label: z.string().max(200).optional(),
}) as unknown as z.ZodType<ConnectorData>;

interface ConnectorLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function ConnectorRead({ data }: PlanBlockReadProps<ConnectorData>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState<ConnectorLine | null>(null);

  useEffect(() => {
    const surface = rootRef.current?.closest<HTMLElement>(`.${SURFACE_CLASS}`);
    if (!surface) return;
    const draw = () => {
      const from = rectWithinSurface(surface, data.from);
      const to = rectWithinSurface(surface, data.to);
      if (!from || !to) {
        setLine(null);
        return;
      }
      // Connect nearest horizontal edges (from-right \u2192 to-left, or reversed).
      const fromRightOfTo = from.left > to.left;
      const start = {
        x: fromRightOfTo ? from.left : from.left + from.width,
        y: from.top + from.height / 2,
      };
      const end = {
        x: fromRightOfTo ? to.left + to.width : to.left,
        y: to.top + to.height / 2,
      };
      setLine({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [data.from, data.to]);

  const markerId = `plan-connector-arrow-${data.from}-${data.to}`;
  return (
    <div ref={rootRef} className="plan-canvas-connector" style={{ position: "absolute", inset: 0 }}>
      {line ? (
        <svg className="plan-canvas-connector-svg" width="100%" height="100%" aria-hidden>
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
            </marker>
          </defs>
          <line
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            className="stroke-muted-foreground/70"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            markerEnd={`url(#${markerId})`}
          />
          {data.label ? (
            <text
              x={(line.x1 + line.x2) / 2}
              y={(line.y1 + line.y2) / 2 - 6}
              textAnchor="middle"
              className={cn("plan-canvas-connector-label", "fill-muted-foreground")}
            >
              {data.label}
            </text>
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}

export const connectorBlock: PlanBlock<ConnectorData> = {
  schema: connectorSchema,
  Read: ConnectorRead,
  mdx: {
    tag: "Connector",
    toAttrs: (data) => ({ from: data.from, to: data.to, label: data.label }),
    fromAttrs: (attrs) =>
      ({
        from: attrs.string("from") ?? "",
        to: attrs.string("to") ?? "",
        label: attrs.string("label"),
      }) as ConnectorData,
  },
};
