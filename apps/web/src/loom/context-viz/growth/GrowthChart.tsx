// loom: "How the window filled" (plan §6): context per call as a stepped area, x in call order
// (idle gaps are marked, never drawn as time), risers coloured by what each step added, cliff
// labels, the hatched avoidable band under its dashed "without" line, and the added-per-step bars.
// Hand-rolled SVG; nothing animates, hover and pin are a rect and a class.
import { type MouseEvent as ReactMouseEvent, type ReactNode, useId, useState } from "react";

import { observeResize } from "../../../lib/observeResize";
import { formatCostUsd } from "../../costFormat";
import { formatContextTokens } from "../format";
import { CLASS_META, type Cliff, type GrowthClass, type GrowthModel, type Unit } from "./series";

export interface GrowthChartProps {
  readonly model: GrowthModel;
  readonly units: ReadonlyArray<Unit>;
  readonly cliffs: ReadonlyArray<Cliff>;
  readonly perTurn: boolean;
  readonly mute: number;
  readonly scale: "fit" | "window";
  readonly contextWindow: number | null;
  readonly lit: { readonly ids: ReadonlySet<string>; readonly cls: GrowthClass } | null;
  readonly hovered: number | null;
  readonly pinned: number | null;
  readonly onHover: (unit: number | null) => void;
  readonly onPick: (unit: number) => void;
}

const PAD_L = 38;
const PAD_R = 8;
const TOP = 20;
const MAIN_H = 200;
const GAP = 22;
const TRACK_H = 64;
const AXIS_H = 16;
const HEIGHT = TOP + MAIN_H + GAP + TRACK_H + AXIS_H;
const TRACK_TOP = TOP + MAIN_H + GAP;
const TRACK_BOTTOM = TRACK_TOP + TRACK_H;
const fmt = formatContextTokens;

/** Text over the chart keeps a halo of the panel's background so it reads over the area. */
const HALO = { paintOrder: "stroke", stroke: "var(--background)", strokeWidth: 3 } as const;

function Label({
  x,
  y,
  anchor = "start",
  tone = "muted",
  bold = false,
  children,
}: {
  readonly x: number;
  readonly y: number;
  readonly anchor?: "start" | "middle" | "end";
  readonly tone?: "muted" | "fg" | "idle";
  readonly bold?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={10}
      textAnchor={anchor}
      fontWeight={bold ? 600 : undefined}
      className={
        tone === "fg"
          ? "fill-foreground"
          : tone === "idle"
            ? "fill-warning-foreground"
            : "fill-muted-foreground"
      }
      style={HALO}
    >
      {children}
    </text>
  );
}

const niceMax = (peak: number) => {
  const target = peak * 1.15;
  const step = [10e3, 25e3, 50e3, 100e3, 200e3, 250e3, 500e3].find((s) => target / s <= 5) ?? 1e6;
  return { max: Math.max(step, Math.ceil(target / step) * step), step };
};

const idleText = (minutes: number, cacheLapsed: boolean, cost: number | null) => {
  const rewrite = formatCostUsd(cost);
  return `${minutes >= 90 ? `${(minutes / 60).toFixed(1)}h` : `${Math.round(minutes)}m`} idle${
    cacheLapsed ? ` · cache lapsed${rewrite ? `, rewrite ${rewrite}` : ""}` : ""
  }`;
};

export function GrowthChart(props: GrowthChartProps) {
  const { model, units, perTurn, mute, lit, contextWindow } = props;
  const ids = useId().replace(/:/g, "");
  const [width, setWidth] = useState(0);
  const measure = (element: HTMLDivElement | null) => {
    if (!element) return;
    return observeResize(element, ([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
  };

  const steps = model.steps;
  const n = Math.max(1, steps.length);
  const plotW = Math.max(1, width - PAD_L - PAD_R);
  const x = (k: number) => PAD_L + (k * plotW) / n;
  const peak = steps.reduce((max, step) => Math.max(max, step.call.ctx), 0);
  const windowScale = props.scale === "window" && contextWindow !== null;
  const { max: yMax, step: yStep } = windowScale
    ? { max: contextWindow, step: contextWindow / 4 }
    : niceMax(peak);
  const y = (tokens: number) => TOP + MAIN_H - (Math.max(0, tokens) / yMax) * MAIN_H;
  const unitOfK: number[] = [];
  for (const unit of units) for (let k = unit.k0; k <= unit.k1; k++) unitOfK[k] = unit.index;
  const litTokens = (unit: Unit) =>
    lit ? unit.items.reduce((s, e) => s + (lit.ids.has(e.item.id) ? e.item.tokens : 0), 0) : 0;

  const chart = () => {
    const out: ReactNode[] = [];
    // Alternate turns get a faint band, so a 58-turn session still reads by turn.
    let turnStart = 0;
    let lastTurnLabel = -Infinity;
    steps.forEach((step, k) => {
      if (k < steps.length - 1 && steps[k + 1]!.turn === step.turn) return;
      if (model.turns > 1 && step.turn % 2 === 0)
        out.push(
          <rect
            key={`band${step.call.index}`}
            x={x(turnStart)}
            y={TOP}
            width={x(k + 1) - x(turnStart)}
            height={TRACK_BOTTOM - TOP}
            className="fill-foreground/[0.025]"
          />,
        );
      const mid = (x(turnStart) + x(k + 1)) / 2;
      if (model.turns > 1 && mid - lastTurnLabel > 30) {
        out.push(
          <Label key={`tl${step.call.index}`} x={mid} y={HEIGHT - 4} anchor="middle">
            T{step.turn}
          </Label>,
        );
        lastTurnLabel = mid;
      }
      turnStart = k + 1;
    });
    if (model.turns <= 1) {
      const every = Math.max(1, Math.ceil(30 / (plotW / n) / 10) * 10);
      for (let k = 0; k < steps.length; k += every)
        out.push(
          <Label key={`cl${k}`} x={x(k) + 2} y={HEIGHT - 4} anchor="middle">
            {steps[k]!.call.index}
          </Label>,
        );
    }

    for (let tokens = 0; tokens < yMax; tokens += yStep)
      out.push(
        <g key={`g${tokens}`}>
          <line
            x1={PAD_L}
            x2={width - PAD_R}
            y1={y(tokens)}
            y2={y(tokens)}
            className="stroke-foreground/5"
          />
          <Label x={PAD_L - 5} y={y(tokens) + 3} anchor="end">
            {fmt(tokens)}
          </Label>
        </g>,
      );
    if (windowScale)
      out.push(
        <g key="window">
          <line
            x1={PAD_L}
            x2={width - PAD_R}
            y1={y(yMax)}
            y2={y(yMax)}
            className="stroke-foreground/25"
          />
          <Label x={PAD_L - 5} y={y(yMax) + 3} anchor="end">
            {fmt(yMax)}
          </Label>
          <Label x={width - PAD_R} y={y(yMax) + 12} anchor="end">
            window {fmt(yMax)}
          </Label>
        </g>,
      );
    else
      out.push(
        <g key="fit">
          <line x1={PAD_L} x2={width - PAD_R} y1={TOP} y2={TOP} className="stroke-foreground/10" />
          <Label x={PAD_L - 5} y={TOP + 3} anchor="end">
            {fmt(yMax)}
          </Label>
          {contextWindow !== null ? (
            <Label x={width - PAD_R} y={TOP + 12} anchor="end">
              fitted to this session · the {fmt(contextWindow)} window is above
            </Label>
          ) : null}
        </g>,
      );

    // The area, the avoidable bands between ctx and the "without" line, then the two lines.
    let area = `M${x(0)},${y(0)}`;
    let line = "";
    let without = "";
    steps.forEach((step, k) => {
      area += `V${y(step.call.ctx)}H${x(k + 1)}`;
      line += `${k ? "V" : `M${x(0)},`}${y(step.call.ctx)}H${x(k + 1)}`;
      without += `${k ? "V" : `M${x(0)},`}${y(step.withoutAvoidable)}H${x(k + 1)}`;
    });
    const band = (top: (k: number) => number, bottom: (k: number) => number) =>
      `M${steps.map((_, k) => `${x(k)},${y(top(k))}L${x(k + 1)},${y(top(k))}`).join("L")}L${steps
        .map((_, k) => steps.length - 1 - k)
        .map((k) => `${x(k + 1)},${y(bottom(k))}L${x(k)},${y(bottom(k))}`)
        .join("L")}Z`;
    out.push(<path key="area" d={`${area}V${y(0)}Z`} className="fill-foreground/[0.05]" />);
    const final = steps.at(-1);
    const hasAvoidable = steps.some((step) => step.withoutAvoidable < step.call.ctx);
    if (final && hasAvoidable) {
      out.push(
        <path
          key="bandTooling"
          d={band(
            (k) => steps[k]!.call.ctx,
            (k) => steps[k]!.withoutTooling,
          )}
          fill={`url(#${ids}-tooling)`}
        />,
        <path
          key="bandGuidance"
          d={band(
            (k) => steps[k]!.withoutTooling,
            (k) => steps[k]!.withoutAvoidable,
          )}
          fill={`url(#${ids}-guidance)`}
        />,
        <path
          key="without"
          d={without}
          fill="none"
          strokeWidth={1.2}
          strokeDasharray="4 3"
          className="stroke-foreground/70"
        />,
        <Label
          key="withoutLabel"
          x={width - PAD_R - 2}
          y={y(final.withoutAvoidable) + 13}
          anchor="end"
          tone="fg"
        >
          without the avoidable items: {fmt(final.withoutAvoidable)}
        </Label>,
      );
    }
    out.push(
      <path key="line" d={line} fill="none" strokeWidth={1.2} className="stroke-foreground/55" />,
    );
    if (final)
      out.push(
        <Label
          key="final"
          x={width - PAD_R - 2}
          y={y(final.call.ctx) - 6}
          anchor="end"
          tone="fg"
          bold
        >
          {fmt(final.call.ctx)}
        </Label>,
      );

    // Idle gaps and compactions: dashed verticals, since x is call order and hides the clock.
    let lastMarkX = -Infinity;
    let markRow = 0;
    steps.forEach((step, k) => {
      if (!step.idle && !step.compacted) return;
      markRow = x(k) - lastMarkX < 150 ? markRow + 1 : 0;
      lastMarkX = x(k);
      const right = x(k) > width / 2;
      out.push(
        <g key={`mark${step.call.index}`}>
          <line
            x1={x(k)}
            x2={x(k)}
            y1={TOP + 2}
            y2={TRACK_BOTTOM}
            strokeDasharray="2 3"
            className="stroke-warning/60"
          />
          <Label
            x={x(k) + (right ? -4 : 4)}
            y={TOP + 26 + markRow * 12}
            anchor={right ? "end" : "start"}
            tone="idle"
          >
            {step.idle
              ? idleText(step.idle.minutes, step.idle.cacheLapsed, step.idle.rewriteCostUsd)
              : "compacted"}
          </Label>
        </g>,
      );
    });

    // Risers: a step at or above the mute threshold is drawn in the colour of what it added most.
    for (const unit of units) {
      if (unit.k0 === 0 || unit.compacted || unit.total < mute) continue;
      out.push(
        <line
          key={`r${unit.index}`}
          x1={x(unit.k0)}
          x2={x(unit.k0)}
          y1={y(unit.prevCtx)}
          y2={y(unit.ctx)}
          stroke={unit.causes[0]?.cause.color}
          strokeWidth={Math.max(2, Math.min(4, x(unit.k1 + 1) - x(unit.k0)))}
          opacity={lit && litTokens(unit) === 0 ? 0.25 : 1}
        />,
      );
    }

    // Added per step, stacked by cause; muted steps recede, a lit finding's items stand out.
    const trackMax = Math.max(
      1,
      ...units.filter((unit) => unit.k0 > 0 && !unit.compacted).map((unit) => unit.total),
    );
    out.push(
      <Label key="trackMax" x={PAD_L - 5} y={TRACK_TOP + 8} anchor="end">
        {fmt(trackMax)}
      </Label>,
      <Label key="trackZero" x={PAD_L - 5} y={TRACK_BOTTOM} anchor="end">
        0
      </Label>,
      <Label key="trackTitle" x={PAD_L + 4} y={TRACK_TOP - 5}>
        added per {perTurn ? "turn" : "call"} · steps under {fmt(mute)} muted
      </Label>,
    );
    for (const unit of units) {
      const x0 = x(unit.k0);
      const w = Math.max(1, x(unit.k1 + 1) - x0 - (perTurn ? 1.5 : 0.4));
      const fit = unit.total > trackMax ? trackMax / unit.total : 1;
      const parts = new Map<string, { key: string; color: string; tokens: number; on: boolean }>();
      for (const entry of unit.items) {
        const on = !lit || lit.ids.has(entry.item.id);
        const key = `${entry.cause.key}|${on}`;
        const part = parts.get(key) ?? { key, color: entry.cause.color, tokens: 0, on };
        part.tokens += entry.item.tokens;
        parts.set(key, part);
      }
      let base = TRACK_BOTTOM;
      [...parts.values()]
        .sort((a, b) => Number(b.on) - Number(a.on) || b.tokens - a.tokens)
        .forEach((part) => {
          const h = (Math.max(0, part.tokens) / trackMax) * (TRACK_H - 6) * fit;
          base -= h;
          out.push(
            <rect
              key={`t${unit.index}-${part.key}`}
              x={x0}
              y={base}
              width={w}
              height={h}
              fill={part.color}
              opacity={lit ? (part.on ? 1 : 0.14) : unit.total < mute ? 0.3 : 0.95}
            />,
          );
        });
      if (unit.total > trackMax)
        out.push(
          <Label key={`over${unit.index}`} x={x0 + w + 3} y={TRACK_TOP + 8}>
            {fmt(unit.total)} ↑
          </Label>,
        );
    }

    // Cliff labels, nudged up until they clear each other and the final figure.
    // Seed with the final figure and the window label, which sit at the right edge.
    const placed = [
      ...(final ? [{ x: width - PAD_R - 27, y: y(final.call.ctx) - 6, w: 54 }] : []),
      { x: width - PAD_R - 40, y: (windowScale ? y(yMax) : TOP) + 12, w: windowScale ? 80 : 0 },
    ];
    for (const cliff of props.cliffs) {
      const first = cliff.first.steps[0]!.call.index;
      const last = cliff.last.steps.at(-1)!.call.index;
      const where = perTurn
        ? `T${cliff.first.turn}`
        : `${model.turns > 1 ? `T${cliff.first.turn} ` : ""}#${first}${last > first ? `–${last}` : ""}`;
      const text = `+${fmt(cliff.tokens)} ${lit ? "" : `${cliff.cause.label} `}· ${where}`;
      const cx = (x(cliff.first.k0) + x(cliff.last.k1 + 1)) / 2;
      const cy = y(cliff.last.ctx);
      const textW = text.length * 5.3 + 10;
      let ly = cy - 16;
      while (
        ly > 14 &&
        placed.some((p) => Math.abs(p.x - cx) < (p.w + textW) / 2 + 4 && Math.abs(p.y - ly) < 15)
      )
        ly -= 15;
      placed.push({ x: cx, y: ly, w: textW });
      const lx = Math.min(Math.max(cx, PAD_L + textW / 2), width - PAD_R - textW / 2);
      out.push(
        <g key={`cliff${cliff.first.index}`}>
          <line x1={cx} x2={cx} y1={ly + 4} y2={cy - 2} className="stroke-foreground/30" />
          <circle
            cx={cx}
            cy={cy}
            r={2.4}
            fill={lit ? CLASS_META[lit.cls].color : cliff.cause.color}
          />
          <rect
            x={lx - textW / 2}
            y={ly - 10}
            width={textW}
            height={14}
            rx={4}
            className="fill-popover stroke-border"
          />
          <text x={lx} y={ly} fontSize={10} textAnchor="middle" className="fill-foreground">
            {text}
          </text>
        </g>,
      );
    }
    return out;
  };

  const hovered = props.hovered !== null ? units[props.hovered] : undefined;
  const pinned = props.pinned !== null ? units[props.pinned] : undefined;
  const span = (unit: Unit) => ({ x: x(unit.k0), width: Math.max(2, x(unit.k1 + 1) - x(unit.k0)) });
  const unitAt = (event: ReactMouseEvent<SVGRectElement>) => {
    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box) return null;
    const k = Math.floor(((event.clientX - box.left - PAD_L) / plotW) * n);
    return k >= 0 && k < n ? (unitOfK[k] ?? null) : null;
  };

  return (
    <div ref={measure} className="relative w-full">
      {width > 0 ? (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Context size after each of ${steps.length} calls`}
          className="block"
        >
          <defs>
            {(["tooling", "guidance"] as const).map((kind) => (
              <pattern
                key={kind}
                id={`${ids}-${kind}`}
                width={5}
                height={5}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect
                  width={5}
                  height={5}
                  fill={kind === "tooling" ? "rgb(249 115 22 / 10%)" : "rgb(236 72 153 / 10%)"}
                />
                <line
                  x1={0}
                  y1={0}
                  x2={0}
                  y2={5}
                  strokeWidth={1.6}
                  stroke={kind === "tooling" ? "rgb(249 115 22 / 60%)" : "rgb(236 72 153 / 65%)"}
                />
              </pattern>
            ))}
          </defs>
          {chart()}
          {hovered ? (
            <rect
              {...span(hovered)}
              y={TOP}
              height={TRACK_BOTTOM - TOP}
              className="pointer-events-none fill-foreground/[0.07]"
            />
          ) : null}
          {pinned ? (
            <rect
              {...span(pinned)}
              y={TOP}
              height={TRACK_BOTTOM - TOP}
              fill="none"
              className="pointer-events-none stroke-foreground/50"
            />
          ) : null}
          <rect
            x={PAD_L}
            y={TOP}
            width={plotW}
            height={TRACK_BOTTOM - TOP}
            fill="transparent"
            className="cursor-crosshair"
            onPointerMove={(event) => {
              const unit = unitAt(event);
              if (unit !== props.hovered) props.onHover(unit);
            }}
            onPointerLeave={() => props.onHover(null)}
            onClick={(event) => {
              const unit = unitAt(event);
              if (unit !== null) props.onPick(unit);
            }}
          />
        </svg>
      ) : (
        <div style={{ height: HEIGHT }} />
      )}
      {hovered && width > 0 ? (
        <HoverTip
          unit={hovered}
          perTurn={perTurn}
          turns={model.turns}
          x={x(hovered.k0)}
          width={width}
        />
      ) : null}
    </div>
  );
}

function HoverTip({
  unit,
  perTurn,
  turns,
  x,
  width,
}: {
  readonly unit: Unit;
  readonly perTurn: boolean;
  readonly turns: number;
  readonly x: number;
  readonly width: number;
}) {
  const right = x > width / 2;
  const first = unit.steps[0]!.call.index;
  return (
    <div
      className="pointer-events-none absolute top-0 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-0.5 text-2xs text-popover-foreground shadow-md"
      style={right ? { right: width - x + 6 } : { left: x + 6 }}
    >
      {perTurn && turns > 1
        ? `Turn ${unit.turn}`
        : `Call #${first}${turns > 1 ? ` · T${unit.turn}` : ""}`}{" "}
      · <b className="font-medium">+{fmt(unit.total)}</b> → {fmt(unit.ctx)}
      {unit.causes[0] ? ` · mostly ${unit.causes[0].cause.label}` : ""}
    </div>
  );
}
