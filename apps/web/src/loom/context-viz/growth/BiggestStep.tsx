// loom: the panel beside the growth chart (plan §6): the biggest step until a hover or pin names
// another, or a lit finding's items; each row with its exact or estimated tokens and class.
import { formatContextTokens, formatShare } from "../format";
import { CLASS_META, type GrowthClass, type StepItem, type Unit } from "./series";

export interface LitGroup {
  readonly key: string;
  readonly cls: GrowthClass;
  readonly title: string;
  readonly ids: ReadonlySet<string>;
  readonly tokens: number;
  readonly avoidable: number | null;
  readonly exact: boolean;
}

const SHOWN = 12;

function Row({
  entry,
  callIndex,
  onClick,
}: {
  readonly entry: StepItem;
  readonly callIndex: number | null;
  readonly onClick?: () => void;
}) {
  const flagged = entry.cls === "loom_tooling" || entry.cls === "agent_guidance";
  return (
    <li
      className={`grid grid-cols-[9px_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/40 py-1 text-xs ${onClick ? "cursor-pointer hover:bg-accent/50" : ""}`}
      onClick={onClick}
    >
      <span className="size-2.5 rounded-sm" style={{ background: entry.cause.color }} />
      <span className="truncate font-mono text-2xs text-foreground/85">{entry.label}</span>
      <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-2xs tabular-nums">
        {formatContextTokens(entry.item.tokens)}
        {callIndex !== null ? (
          <span className="font-sans text-muted-foreground">#{callIndex}</span>
        ) : null}
        {flagged ? (
          <span
            className="rounded px-1 font-sans text-3xs"
            style={{
              color: CLASS_META[entry.cls].color,
              background: `${CLASS_META[entry.cls].color}22`,
            }}
          >
            {CLASS_META[entry.cls].name}
          </span>
        ) : null}
        {entry.item.measured ? null : (
          <span className="rounded bg-muted px-1 font-sans text-3xs text-muted-foreground">
            est.
          </span>
        )}
      </span>
    </li>
  );
}

function More({ rest }: { readonly rest: ReadonlyArray<StepItem> }) {
  return rest.length > 0 ? (
    <p className="pt-1 text-2xs text-muted-foreground">
      + {rest.length} smaller item{rest.length === 1 ? "" : "s"},{" "}
      {formatContextTokens(rest.reduce((sum, entry) => sum + entry.item.tokens, 0))}
    </p>
  ) : null;
}

export function BiggestStep({
  unit,
  mode,
  perTurn,
  turns,
  contextWindow,
  lit,
  units,
  onPick,
}: {
  readonly unit: Unit | undefined;
  readonly mode: "biggest" | "hovered" | "pinned";
  readonly perTurn: boolean;
  readonly turns: number;
  readonly contextWindow: number | null;
  readonly lit: LitGroup | null;
  readonly units: ReadonlyArray<Unit>;
  readonly onPick: (unit: number) => void;
}) {
  const box = "rounded-lg border border-border/70 p-3";
  const eyebrow = "flex justify-between text-2xs uppercase tracking-wide text-muted-foreground";
  if (lit) {
    const entries = units
      .flatMap((u) =>
        u.items.filter((entry) => lit.ids.has(entry.item.id)).map((entry) => ({ entry, u })),
      )
      .sort((a, b) => b.entry.item.tokens - a.entry.item.tokens);
    return (
      <section className={box}>
        <div className={eyebrow}>
          <span>Finding · {CLASS_META[lit.cls].name}</span>
          <span>
            {entries.length} item{entries.length === 1 ? "" : "s"}
          </span>
        </div>
        <h3 className="mt-1 text-sm font-semibold text-foreground">{lit.title}</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          {formatContextTokens(lit.tokens)} in the window
          {lit.avoidable !== null
            ? ` · avoidable ${lit.exact ? "" : "≈"}${formatContextTokens(lit.avoidable)}`
            : ""}
        </p>
        <ul className="border-t border-border/60">
          {entries.slice(0, SHOWN).map(({ entry, u }) => (
            <Row
              key={entry.item.id}
              entry={entry}
              callIndex={entry.callIndex}
              onClick={() => onPick(u.index)}
            />
          ))}
        </ul>
        <More rest={entries.slice(SHOWN).map(({ entry }) => entry)} />
        <p className="mt-2 text-2xs text-muted-foreground">
          Click a row to pin its step. Click the finding again to clear.
        </p>
      </section>
    );
  }
  if (!unit) return null;
  const first = unit.steps[0]!;
  const lastCall = unit.steps.at(-1)!.call.index;
  const entries = [...unit.items].sort((a, b) => b.item.tokens - a.item.tokens);
  const share = formatShare(unit.ctx, contextWindow);
  return (
    <section className={box}>
      <div className={eyebrow}>
        <span>
          {mode === "pinned"
            ? "Pinned step"
            : mode === "hovered"
              ? "Step under cursor"
              : "Biggest step"}
        </span>
        <span className="normal-case tracking-normal">
          {new Date(first.call.at).toLocaleString(undefined, {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      <h3 className="mt-1 text-sm font-semibold text-foreground">
        {perTurn && turns > 1 ? `Turn ${unit.turn}` : `Call #${first.call.index}`}: +
        {formatContextTokens(unit.total)}
      </h3>
      <p className="mb-2 text-xs text-muted-foreground">
        {unit.steps.length > 1
          ? `calls #${first.call.index}–${lastCall}`
          : `call #${first.call.index}${turns > 1 ? `, turn ${unit.turn}` : ""}`}{" "}
        · {formatContextTokens(unit.prevCtx)} → {formatContextTokens(unit.ctx)}
        {share ? ` (${share} of window)` : ""}
      </p>
      <ul className="border-t border-border/60">
        {entries.slice(0, SHOWN).map((entry) => (
          <Row
            key={entry.item.id}
            entry={entry}
            callIndex={unit.steps.length > 1 ? entry.callIndex : null}
          />
        ))}
      </ul>
      <More rest={entries.slice(SHOWN)} />
      <p className="mt-2 text-2xs text-muted-foreground">
        Hover the chart to inspect a step; click to pin it and scroll the chat to it. Escape unpins.
        est. marks a share of a gap split by characters.
      </p>
    </section>
  );
}
