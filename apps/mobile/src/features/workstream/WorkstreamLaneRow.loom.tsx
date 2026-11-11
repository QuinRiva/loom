/**
 * loom: one row of the workstream's lane graph: its slice of the lanes in a narrow SVG at the
 * left edge, then the row's text. Vertical runs are percentage lines so they stretch with the
 * row; bends, arrowheads and glyphs sit in a fixed band around the dot (§3 of the plan).
 */
import type { ThreadId } from "@t3tools/contracts";
import { memo } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle, Line, Path, Polygon, Rect } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { gutterWidth, type LaneRow, slotX } from "./laneLayout.loom";
import {
  DOT_Y,
  type GlyphShape,
  type GlyphTone,
  gutterShapes,
  type RowGlyph,
  type ShapeColor,
} from "./laneGutterShapes.loom";

const MONO_FONT = "Menlo";

export type LanePalette = Record<ShapeColor, string>;

export function useLanePalette(): LanePalette {
  const lane = useResolveClassNames("text-foreground-tertiary").color;
  const gate = useResolveClassNames("text-primary-text").color;
  const idle = useResolveClassNames("text-foreground-muted").color;
  const running = useResolveClassNames("text-adaptive-sky-600-400").color;
  const done = useResolveClassNames("text-adaptive-emerald-600-400").color;
  const warning = useResolveClassNames("text-warning-foreground").color;
  const error = useResolveClassNames("text-danger-foreground").color;
  const color = (value: unknown) => (typeof value === "string" ? value : "#888888");
  return {
    lane: color(lane),
    gate: color(gate),
    waits: color(idle),
    running: color(running),
    done: color(done),
    idle: color(idle),
    warning: color(warning),
    error: color(error),
  };
}

type TextTone = "warning" | "error";

/** Everything a row shows besides its lanes, compared by value so a row repaints only when it changes. */
export type LaneRowDisplay =
  | {
      readonly kind: "thread";
      readonly title: string;
      readonly role: string;
      readonly state: string;
      readonly stateTone: TextTone | null;
      readonly progress: string | null;
      readonly trailing: { readonly text: string; readonly tone: TextTone | null };
      readonly shape: GlyphShape;
      readonly tone: GlyphTone;
      readonly settled: boolean;
      /** `⟲2/3` on a gate arrow leaving this reviewer's row. */
      readonly badge: string | null;
      /** A sub-orchestrator's chevron: open, closed, or none. */
      readonly foldOpen: boolean | null;
      readonly selected: boolean;
    }
  | { readonly kind: "wave"; readonly text: string; readonly collapsible: boolean }
  | { readonly kind: "fold"; readonly text: string };

const TEXT_TONE_CLASS = {
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
} satisfies Record<TextTone, string>;

function LaneGutter(props: {
  readonly row: LaneRow;
  readonly display: LaneRowDisplay;
  readonly laneCount: number;
  readonly slotCount: number;
  readonly palette: LanePalette;
}) {
  const { display, palette } = props;
  const glyph: RowGlyph =
    display.kind === "thread"
      ? { kind: "thread", shape: display.shape, tone: display.tone }
      : { kind: display.kind };
  return (
    <Svg
      width={gutterWidth(props.laneCount, props.slotCount)}
      height="100%"
      style={{ position: "absolute", left: 0, top: 0, bottom: 0 }}
    >
      {gutterShapes(props.row, glyph, props.laneCount).map((shape) => {
        const key = JSON.stringify(shape);
        const color = palette[shape.color];
        const stroke = {
          stroke: color,
          strokeWidth: shape.color === "gate" ? 1.6 : 1.4,
          strokeDasharray: "dashed" in shape && shape.dashed ? "3,3" : undefined,
        };
        switch (shape.kind) {
          case "line":
            return (
              <Line key={key} x1={shape.x} y1={shape.y1} x2={shape.x} y2={shape.y2} {...stroke} />
            );
          case "path":
            return <Path key={key} d={shape.d} fill="none" {...stroke} />;
          case "arrow":
            return <Polygon key={key} points={shape.points} fill={color} />;
          case "rect":
            return (
              <Rect
                key={key}
                x={shape.x - shape.size / 2}
                y={DOT_Y - shape.size / 2}
                width={shape.size}
                height={shape.size}
                rx={shape.radius}
                fill={shape.filled ? color : "none"}
                stroke={shape.filled ? undefined : color}
                strokeWidth={shape.filled ? undefined : 1.5}
              />
            );
          case "circle":
            return (
              <Circle
                key={key}
                cx={shape.x}
                cy={shape.y}
                r={shape.r}
                fill={shape.filled ? color : "none"}
                stroke={shape.filled ? undefined : color}
                strokeWidth={shape.filled ? undefined : 1.5}
              />
            );
        }
      })}
    </Svg>
  );
}

function RowBody(props: { readonly display: LaneRowDisplay; readonly onToggleFold: () => void }) {
  const { display } = props;
  if (display.kind !== "thread")
    return (
      <View className="flex-row items-center gap-1.5 pt-[13px] pb-2">
        {display.kind === "fold" || display.collapsible ? (
          <SymbolView
            name={display.kind === "fold" ? "chevron.right" : "chevron.down"}
            size={11}
            tintColorClassName="accent-foreground-muted"
          />
        ) : null}
        <Text
          className="shrink text-xs text-foreground-muted"
          numberOfLines={1}
          style={display.kind === "wave" ? { fontFamily: MONO_FONT } : undefined}
        >
          {display.text}
        </Text>
      </View>
    );
  return (
    <View className="py-2.5" style={{ opacity: display.settled ? 0.6 : 1 }}>
      <View className="flex-row items-center gap-2">
        <Text className="shrink text-[15px] font-t3-medium" numberOfLines={1}>
          {display.title}
        </Text>
        {display.foldOpen === null ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={display.foldOpen ? "Collapse sub-threads" : "Expand sub-threads"}
            hitSlop={10}
            onPress={props.onToggleFold}
          >
            <SymbolView
              name={display.foldOpen ? "chevron.down" : "chevron.right"}
              size={12}
              tintColorClassName="accent-foreground-muted"
            />
          </Pressable>
        )}
        <View className="flex-1" />
        <Text
          className={cn(
            "text-xs",
            display.trailing.tone
              ? cn("font-t3-bold", TEXT_TONE_CLASS[display.trailing.tone])
              : "text-foreground-muted",
          )}
          style={display.trailing.tone ? undefined : { fontFamily: MONO_FONT }}
        >
          {display.trailing.text}
        </Text>
      </View>
      <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={1}>
        {display.role} ·{" "}
        <Text
          className={cn(
            "text-xs",
            display.stateTone ? TEXT_TONE_CLASS[display.stateTone] : "text-foreground-muted",
          )}
        >
          {display.state}
        </Text>
        {display.progress ? ` · ${display.progress}` : null}
      </Text>
    </View>
  );
}

export interface WorkstreamLaneRowProps {
  readonly row: LaneRow;
  readonly display: LaneRowDisplay;
  readonly laneCount: number;
  readonly slotCount: number;
  readonly palette: LanePalette;
  readonly onOpen: (threadId: ThreadId) => void;
  readonly onLongPress: (threadId: ThreadId) => void;
  readonly onToggleFold: (row: LaneRow) => void;
}

function WorkstreamLaneRowView(props: WorkstreamLaneRowProps) {
  const { row, display } = props;
  const width = gutterWidth(props.laneCount, props.slotCount);
  const badgeArc =
    display.kind === "thread" && display.badge
      ? row.gutter.arcs.find((arc) => arc.kind === "gate" && arc.joins === "source")
      : undefined;
  const thread = row.kind === "thread" ? row.key : null;
  const toggle = () => props.onToggleFold(row);
  const tappable = row.kind === "fold" || (display.kind === "wave" && display.collapsible);
  return (
    <Pressable
      accessibilityRole={thread || tappable ? "button" : undefined}
      disabled={!thread && !tappable}
      onPress={thread ? () => props.onOpen(thread) : toggle}
      onLongPress={thread ? () => props.onLongPress(thread) : undefined}
      className={cn(
        "flex-row active:bg-row-hover",
        display.kind === "thread" && display.selected && "bg-subtle-strong",
      )}
    >
      <LaneGutter
        row={row}
        display={display}
        laneCount={props.laneCount}
        slotCount={props.slotCount}
        palette={props.palette}
      />
      <View style={{ width }} />
      <View className="min-w-0 flex-1 pr-4 pl-1">
        <RowBody display={display} onToggleFold={toggle} />
      </View>
      {badgeArc && display.kind === "thread" ? (
        <View
          pointerEvents="none"
          className="absolute rounded-full border bg-screen px-1"
          style={{
            left: slotX(badgeArc.slot, props.laneCount) - 15,
            top: badgeArc.below ? DOT_Y + 9 : DOT_Y - 24,
            borderColor: props.palette.gate,
          }}
        >
          <Text className="text-[9px] text-primary-text" style={{ fontFamily: MONO_FONT }}>
            {display.badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** A row repaints only when its layout row, its text or the lane geometry changes. */
export const WorkstreamLaneRow = memo(
  WorkstreamLaneRowView,
  (before, after) =>
    before.row === after.row &&
    before.laneCount === after.laneCount &&
    before.slotCount === after.slotCount &&
    before.palette === after.palette &&
    before.onOpen === after.onOpen &&
    before.onLongPress === after.onLongPress &&
    before.onToggleFold === after.onToggleFold &&
    JSON.stringify(before.display) === JSON.stringify(after.display),
);
