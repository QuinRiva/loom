/**
 * loom: what a lane row's gutter draws, as plain SVG shapes. Pure and free of React Native so a
 * scratch script can render real workstreams to HTML with exactly the phone's geometry. `y` is a
 * number of dp from the row's top, or "100%" for the row's bottom, so lines stretch with the row.
 */
import { type LaneRow, laneX, slotX } from "./laneLayout.loom";

/** The glyph's centre, a fixed distance from the row's top. */
export const DOT_Y = 21;
/** Where a lane's line stops short of its glyph. */
const GAP = 6;
const BEND = 7;

export type GlyphShape = "square" | "dot" | "ring" | "ringDot";
/** A colour role; the caller maps it to a theme colour. */
export type ShapeColor =
  | "lane"
  | "gate"
  | "waits"
  | "running"
  | "done"
  | "idle"
  | "warning"
  | "error";
export type GlyphTone = Exclude<ShapeColor, "lane" | "gate" | "waits">;
type Y = number | "100%";

export type GutterShape =
  | {
      readonly kind: "line";
      readonly x: number;
      readonly y1: Y;
      readonly y2: Y;
      readonly color: ShapeColor;
      readonly dashed: boolean;
    }
  | {
      readonly kind: "path";
      readonly d: string;
      readonly color: ShapeColor;
      readonly dashed: boolean;
    }
  | { readonly kind: "arrow"; readonly points: string; readonly color: ShapeColor }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly size: number;
      readonly radius: number;
      readonly color: ShapeColor;
      readonly filled: boolean;
    }
  | {
      readonly kind: "circle";
      readonly x: number;
      readonly y: number;
      readonly r: number;
      readonly color: ShapeColor;
      readonly filled: boolean;
    };

/** The row's glyph: a wave's square, a fold's two dots, or a thread's shape in its tone. */
export type RowGlyph =
  | { readonly kind: "wave" }
  | { readonly kind: "fold" }
  | { readonly kind: "thread"; readonly shape: GlyphShape; readonly tone: GlyphTone };

function glyphShapes(glyph: RowGlyph, x: number): GutterShape[] {
  if (glyph.kind === "wave")
    return [{ kind: "rect", x, size: 9, radius: 2, color: "lane", filled: false }];
  if (glyph.kind === "fold")
    return [-3, 3].map((dy) => ({
      kind: "circle",
      x,
      y: DOT_Y + dy,
      r: 1.8,
      color: "idle",
      filled: true,
    }));
  const color = glyph.tone;
  switch (glyph.shape) {
    case "square":
      return [{ kind: "rect", x, size: 10, radius: 2.5, color, filled: true }];
    case "dot":
      return [{ kind: "circle", x, y: DOT_Y, r: 4.5, color, filled: true }];
    case "ring":
      return [{ kind: "circle", x, y: DOT_Y, r: 4.5, color, filled: false }];
    case "ringDot":
      return [
        { kind: "circle", x, y: DOT_Y, r: 5, color, filled: false },
        { kind: "circle", x, y: DOT_Y, r: 2, color, filled: true },
      ];
  }
}

export function gutterShapes(row: LaneRow, glyph: RowGlyph, laneCount: number): GutterShape[] {
  const glyphLane = row.kind === "wave" ? 0 : row.lane;
  const gx = laneX(glyphLane);
  const line = (x: number, y1: Y, y2: Y, color: ShapeColor = "lane", dashed = false) =>
    ({ kind: "line", x, y1, y2, color, dashed }) as const;
  const shapes: GutterShape[] = row.gutter.lanes.flatMap(({ lane, above, below }) => {
    const x = laneX(lane);
    const stop = lane === glyphLane ? GAP : 0;
    return [
      ...(above ? [line(x, 0, DOT_Y - stop)] : []),
      ...(below ? [line(x, DOT_Y + stop, "100%")] : []),
    ];
  });
  if (row.gutter.forkTo !== null) {
    const fx = laneX(row.gutter.forkTo);
    shapes.push(
      {
        kind: "path",
        d: `M ${gx + GAP} ${DOT_Y} H ${fx - BEND} Q ${fx} ${DOT_Y} ${fx} ${DOT_Y + BEND}`,
        color: "lane",
        dashed: false,
      },
      line(fx, DOT_Y + BEND, "100%"),
    );
  }
  for (const arc of row.gutter.arcs) {
    const sx = slotX(arc.slot, laneCount);
    const color = arc.kind === "gate" ? "gate" : "waits";
    const dashed = arc.kind === "waits";
    if (arc.joins === "none") {
      shapes.push(line(sx, arc.above ? 0 : DOT_Y, arc.below ? "100%" : DOT_Y, color, dashed));
      continue;
    }
    // The arrowhead sits at the target's glyph: the waiter of a wait, the rework target of a gate.
    const start = gx + GAP + (arc.joins === "target" ? 5 : 0);
    if (arc.above && arc.below)
      shapes.push(
        { kind: "path", d: `M ${start} ${DOT_Y} H ${sx}`, color, dashed },
        line(sx, 0, "100%", color, dashed),
      );
    else {
      const turn = arc.above ? DOT_Y - BEND : DOT_Y + BEND;
      shapes.push(
        {
          kind: "path",
          d: `M ${start} ${DOT_Y} H ${sx - BEND} Q ${sx} ${DOT_Y} ${sx} ${turn}`,
          color,
          dashed,
        },
        line(sx, arc.above ? 0 : turn, arc.above ? turn : "100%", color, dashed),
      );
    }
    if (arc.joins === "target")
      shapes.push({
        kind: "arrow",
        points: `${gx + GAP},${DOT_Y} ${gx + GAP + 6},${DOT_Y - 3.5} ${gx + GAP + 6},${DOT_Y + 3.5}`,
        color,
      });
  }
  return [...shapes, ...glyphShapes(glyph, gx)];
}
