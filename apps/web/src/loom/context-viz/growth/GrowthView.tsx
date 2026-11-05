// loom: the Growth sub-view (plan §6): what the window holds by cause in one sentence and bar,
// how it filled call by call, the step under the cursor, and the server's findings. Its controls
// are component state (tier 4); per call by default, since a child thread is one turn.
import type { LoomContextReport } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { useConversationJumpStore } from "../../conversationJump";
import type { ContextViewProps } from "../contextUsageStore";
import { formatContextTokens, formatShare, paletteInk } from "../format";
import { BiggestStep, type LitGroup } from "./BiggestStep";
import { FindingsList, growthCards } from "./FindingsList";
import { GrowthChart } from "./GrowthChart";
import {
  biggestUnit,
  buildGrowthModel,
  CLASS_META,
  cliffs,
  type GrowthClass,
  type GrowthModel,
  growthUnits,
} from "./series";

const MUTES = [2_000, 5_000, 10_000] as const;
const NUMBER_WORDS = ["no", "one", "two", "three"];

export interface GrowthViewState {
  readonly perTurn: boolean;
  readonly mute: number;
  readonly scale: "fit" | "window";
  readonly litKey: string | null;
  readonly pinned: number | null;
}

/** `initial` seeds the controls; the preview harness uses it to show a pinned step or lit finding. */
export function GrowthView({
  report,
  threadRef,
  contextWindow,
  initial,
}: ContextViewProps & { readonly initial?: Partial<GrowthViewState> }) {
  const model = buildGrowthModel(report);
  const cards = growthCards(report, model);
  const latest = report.totals.latestCtx;
  const [perTurn, setPerTurn] = useState(initial?.perTurn ?? false);
  const [mute, setMute] = useState(initial?.mute ?? 5_000);
  const [scale, setScale] = useState<"fit" | "window">(
    initial?.scale ?? (contextWindow !== null && latest > contextWindow / 2 ? "window" : "fit"),
  );
  const [lit, setLit] = useState<LitGroup | null>(
    cards.find((card) => card.key === initial?.litKey) ?? null,
  );
  const [pinned, setPinned] = useState<number | null>(initial?.pinned ?? null);
  const [hovered, setHovered] = useState<number | null>(null);
  const units = growthUnits(model.steps, perTurn);
  const shownCliffs = cliffs(units, mute, lit?.ids ?? null);

  const pin = (index: number | null) => {
    setPinned(index);
    const unit = index === null ? undefined : units[index];
    if (!unit) return;
    setLit(null);
    // The chat lands on the step's earliest item: the first result or message it added.
    const at = unit.items.reduce(
      (min, entry) => (entry.item.at < min ? entry.item.at : min),
      unit.steps[0]!.call.at,
    );
    useConversationJumpStore.getState().setRequest({ threadId: threadRef.threadId, at });
  };
  const shown = pinned ?? hovered;

  return (
    <div
      className="@container flex flex-col gap-4 outline-none"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && pinned !== null) setPinned(null);
      }}
    >
      <Summary model={model} report={report} contextWindow={contextWindow} />
      <section className="rounded-lg border border-border/70 px-3 pt-2.5 pb-2">
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="text-sm font-semibold text-foreground">How the window filled</h3>
          <span className="text-xs text-muted-foreground">
            {model.steps.length} calls, x is call order
          </span>
        </div>
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-muted-foreground">
          <Control label="Steps">
            <ToggleGroup
              aria-label="Steps"
              value={[perTurn ? "turn" : "call"]}
              onValueChange={(next) => {
                if (next[0] === undefined) return;
                setPerTurn(next[0] === "turn");
                setPinned(null);
                setHovered(null);
              }}
            >
              <Toggle value="call">per call</Toggle>
              <Toggle value="turn" disabled={model.turns < 2}>
                per turn
              </Toggle>
            </ToggleGroup>
          </Control>
          <Control label="Mute under">
            <ToggleGroup
              aria-label="Mute steps under"
              value={[String(mute)]}
              onValueChange={(next) => {
                if (next[0] !== undefined) setMute(Number(next[0]));
              }}
            >
              {MUTES.map((value) => (
                <Toggle key={value} value={String(value)}>
                  {formatContextTokens(value)}
                </Toggle>
              ))}
            </ToggleGroup>
          </Control>
          {contextWindow !== null ? (
            <Control label="Scale">
              <ToggleGroup
                aria-label="Scale"
                value={[scale]}
                onValueChange={(next) => {
                  if (next[0] === "fit" || next[0] === "window") setScale(next[0]);
                }}
              >
                <Toggle value="fit">fit</Toggle>
                <Toggle value="window">window</Toggle>
              </ToggleGroup>
            </Control>
          ) : null}
        </div>
        <Legend model={model} />
        <GrowthChart
          model={model}
          units={units}
          cliffs={shownCliffs}
          perTurn={perTurn}
          mute={mute}
          scale={scale}
          contextWindow={contextWindow}
          lit={lit}
          hovered={hovered}
          pinned={pinned}
          onHover={setHovered}
          onPick={(index) => pin(pinned === index ? null : index)}
        />
      </section>
      <div className="grid items-start gap-3 @3xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <FindingsList
          cards={cards}
          latestCtx={latest}
          lit={lit?.key ?? null}
          onSelect={(card) => {
            setLit(card);
            setPinned(null);
          }}
        />
        <div className="order-first @3xl:sticky @3xl:top-0 @3xl:order-none">
          <BiggestStep
            unit={shown !== null ? units[shown] : biggestUnit(units)}
            mode={pinned !== null ? "pinned" : hovered !== null ? "hovered" : "biggest"}
            perTurn={perTurn}
            turns={model.turns}
            contextWindow={contextWindow}
            lit={lit}
            units={units}
            onPick={pin}
          />
        </div>
      </div>
    </div>
  );
}

function Control({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {label}
      {children}
    </span>
  );
}

const Swatch = ({ color, hatch = false }: { readonly color: string; readonly hatch?: boolean }) => (
  <span
    className="inline-block size-2.5 shrink-0 rounded-sm"
    style={{
      background: hatch
        ? `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 5px)`
        : color,
    }}
  />
);

function Legend({ model }: { readonly model: GrowthModel }) {
  const hatches = (["loom_tooling", "agent_guidance"] as const).filter(
    (cls) => model.classTotals[cls] > 0,
  );
  return (
    <div className="mb-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
      {model.causes.map((cause) => (
        <span key={cause.key} className="flex items-center gap-1.5">
          <Swatch color={cause.color} />
          {cause.label}
        </span>
      ))}
      {hatches.map((cls) => (
        <span key={cls} className="flex items-center gap-1.5">
          <Swatch color={CLASS_META[cls].color} hatch />
          avoidable: {CLASS_META[cls].name}
        </span>
      ))}
    </div>
  );
}

function Summary({
  model,
  report,
  contextWindow,
}: {
  readonly model: GrowthModel;
  readonly report: LoomContextReport;
  readonly contextWindow: number | null;
}) {
  const latest = report.totals.latestCtx;
  const totals = model.classTotals;
  const unusedSchemas = report.findings.find((f) => f.rule === "unused_tool_schemas");
  const findingsOf = (cls: GrowthClass) => report.findings.filter((f) => f.class === cls).length;
  const traced = (cls: "loom_tooling" | "agent_guidance", lead: string) => {
    const count = findingsOf(cls);
    return count > 0 ? (
      <>
        {lead}
        <b className="font-medium text-foreground">{formatContextTokens(totals[cls])}</b>{" "}
        {cls === "loom_tooling" ? "traces to" : "to"} {NUMBER_WORDS[count] ?? count}{" "}
        <span style={{ color: paletteInk(CLASS_META[cls].color) }}>
          {cls === "loom_tooling" ? "Loom tooling" : "agent-guidance"}
        </span>{" "}
        finding{count === 1 ? "" : "s"}
      </>
    ) : null;
  };
  const whole = contextWindow ?? latest;
  const avoidable = model.avoidableInWindow;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums text-foreground">
          {formatContextTokens(latest)}
          {contextWindow !== null ? (
            <small className="ml-1 text-sm font-normal tracking-normal text-muted-foreground">
              of {formatContextTokens(contextWindow)}
            </small>
          ) : null}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-foreground/85">
        <b className="font-medium text-foreground">{formatContextTokens(totals.fixed)}</b> is the
        system prompt and the schemas of tools this session called
        {unusedSchemas
          ? ` (the ${formatContextTokens(unusedSchemas.tokens)} of never-called schemas counts under Loom tooling)`
          : ""}
        . {traced("loom_tooling", "")}
        {findingsOf("loom_tooling") > 0 && findingsOf("agent_guidance") > 0 ? ", " : null}
        {traced("agent_guidance", "")}
        {findingsOf("loom_tooling") + findingsOf("agent_guidance") > 0 ? ", and " : null}
        <b className="font-medium text-foreground">{formatContextTokens(totals.task)}</b> is the
        task itself.{" "}
        {avoidable > 0 ? (
          <>
            About <b className="font-medium text-foreground">{formatContextTokens(avoidable)}</b> is
            avoidable; without it the session would have ended near{" "}
            <b className="font-medium text-foreground">{formatContextTokens(latest - avoidable)}</b>
            .
          </>
        ) : (
          "None of the three rules found anything avoidable."
        )}
      </p>
      <div className="flex h-3.5 overflow-hidden rounded bg-foreground/[0.04] ring-1 ring-border ring-inset">
        {(["fixed", "loom_tooling", "agent_guidance", "task"] as const).map((cls) => (
          <div
            key={cls}
            style={{
              width: `${(totals[cls] / whole) * 100}%`,
              background: CLASS_META[cls].color,
              opacity: cls === "task" ? 0.55 : 1,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        {(["fixed", "loom_tooling", "agent_guidance", "task"] as const)
          .filter((cls) => totals[cls] > 0)
          .map((cls) => (
            <span key={cls} className="flex items-center gap-1.5">
              <Swatch color={CLASS_META[cls].color} />
              {CLASS_META[cls].name}{" "}
              <b className="font-medium text-foreground tabular-nums">
                {formatContextTokens(totals[cls])}
              </b>
              · {formatShare(totals[cls], latest)}
            </span>
          ))}
        {contextWindow !== null ? (
          <span className="ml-auto">{formatContextTokens(contextWindow - latest)} free</span>
        ) : null}
      </div>
    </section>
  );
}
