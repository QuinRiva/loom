import { IconColumns, IconFileDiff, IconList } from "@tabler/icons-react";
import { Fragment, useMemo, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../ui/tooltip";
import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { WrapToggle } from "./wrapToggle";

/**
 * The `<Diff>` block — a GitHub-style before/after line diff, unified or split.
 * The differ is a small self-contained LCS (`diffTokens`, ported from
 * `@agent-native/core` `DiffBlock.tsx`) run over lines, then over the words of
 * each paired changed line — NO `jsdiff`/`diff` runtime dependency.
 * Line-anchored `annotations` (mirroring `<AnnotatedCode>`, plus a `side`)
 * render as a note list below the diff. Schema + MDX round-trip ported verbatim
 * from `@agent-native/core` `diff.config.ts` (flat attrs; `before`/`after`
 * multiline string attrs; `annotations` a JSON array attr).
 */

export type DiffMode = "unified" | "split";

export interface DiffAnnotation {
  side?: "before" | "after";
  lines: string;
  label?: string;
  note: string;
}

export interface DiffData {
  filename?: string;
  language?: string;
  before: string;
  after: string;
  mode?: DiffMode;
  annotations?: DiffAnnotation[];
  /** Initial soft-wrap state (§5). Toggleable in the header regardless. */
  wrap?: boolean;
}

const lineRefSchema = z
  .string()
  .trim()
  .max(40)
  .regex(/^\d+(\s*-\s*\d+)?$/, 'lines must be a 1-based line ref like "3" or "3-5"');

const diffAnnotationSchema = z.object({
  side: z.enum(["before", "after"]).optional(),
  lines: lineRefSchema,
  label: z.string().trim().max(160).optional(),
  note: z.string().trim().min(1).max(4000),
}) as z.ZodType<DiffAnnotation>;

const diffSchema = z.object({
  filename: z.string().trim().max(400).optional(),
  language: z.string().trim().max(40).optional(),
  before: z.string().max(100_000),
  after: z.string().max(100_000),
  mode: z.enum(["unified", "split"]).optional(),
  annotations: z.array(diffAnnotationSchema).max(80).optional(),
  wrap: z.boolean().optional(),
}) as unknown as z.ZodType<DiffData>;

const diffMdx: BlockMdxConfig<DiffData> = {
  tag: "Diff",
  toAttrs: (data) => ({
    filename: data.filename,
    language: data.language,
    mode: data.mode,
    before: data.before,
    after: data.after,
    annotations: data.annotations,
    wrap: data.wrap,
  }),
  fromAttrs: (attrs) =>
    ({
      filename: attrs.string("filename"),
      language: attrs.string("language"),
      mode: attrs.string("mode") as DiffMode | undefined,
      before: attrs.string("before") ?? "",
      after: attrs.string("after") ?? "",
      annotations: attrs.array<DiffAnnotation>("annotations"),
      wrap: attrs.bool("wrap"),
    }) as DiffData,
};

/* ── Inline token differ (LCS) — replaces jsdiff `diffLines` ────────────────── */

type DiffRowKind = "context" | "added" | "removed";

interface Change {
  kind: DiffRowKind;
  value: string;
}

const MAX_DIFF_LCS_CELLS = 1_000_000;

/** A minimal LCS diff over token arrays, one `Change` per token; `undefined`
 * when the table would exceed {@link MAX_DIFF_LCS_CELLS}. */
function diffTokens(a: string[], b: string[]): Change[] | undefined {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_LCS_CELLS) return undefined;

  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from<number>({ length: m + 1 }).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      changes.push({ kind: "context", value: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!)
      changes.push({ kind: "removed", value: a[i++]! });
    else changes.push({ kind: "added", value: b[j++]! });
  }
  while (i < n) changes.push({ kind: "removed", value: a[i++]! });
  while (j < m) changes.push({ kind: "added", value: b[j++]! });
  return changes;
}

/** Lines each KEEPING their trailing newline. */
const toLineTokens = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function diffLines(before: string, after: string): Change[] {
  return (
    diffTokens(toLineTokens(before), toLineTokens(after)) ?? [
      { kind: "removed", value: before },
      { kind: "added", value: after },
    ]
  );
}

/* loom: word-level emphasis inside a positionally paired removed/added line —
 * the same tokens (words, whitespace runs, single punctuation) and gap-joining
 * as `@pierre/diffs` `lineDiffType: "word-alt"`, so the plan diff reads like the
 * diff panel. `[emphasised, text]` spans; `undefined` (whole-line rows) when the
 * lines share too few words for positional pairing to mean anything, or are too
 * long for the LCS budget. */
type WordSpan = [emphasis: boolean, text: string];

const WORD_TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MIN_SHARED_WORD_RATIO = 0.3;

function diffWords(before: string, after: string): [WordSpan[], WordSpan[]] | undefined {
  const changes = diffTokens(before.match(WORD_TOKEN) ?? [], after.match(WORD_TOKEN) ?? []);
  if (!changes) return undefined;
  const words = changes.filter((c) => /\S/.test(c.value));
  const shared = words.filter((c) => c.kind === "context").length;
  // shared / mean word count of the two lines
  if ((2 * shared) / (words.length + shared || 1) < MIN_SHARED_WORD_RATIO) return undefined;

  const spans: Record<"removed" | "added", WordSpan[]> = { removed: [], added: [] };
  changes.forEach((change, index) => {
    const emphasis = change.kind !== "context";
    // word-alt: a one-char unchanged gap (a space) before another change joins the
    // emphasised run, so an edited phrase reads as one block, not confetti.
    const joins = (last: WordSpan) =>
      last[0] === emphasis ||
      (last[0] &&
        change.value.length === 1 &&
        (changes[index + 1]?.kind ?? "context") !== "context");
    for (const side of ["removed", "added"] as const) {
      if (emphasis && change.kind !== side) continue;
      const last = spans[side].at(-1);
      if (last && joins(last)) last[1] += change.value;
      else spans[side].push([emphasis, change.value]);
    }
  });
  // Edge whitespace of an emphasised run stays plain, so blocks hug their words.
  const tidy = (side: WordSpan[]) =>
    side
      .flatMap(([emphasis, text]): WordSpan[] => {
        const [, lead = "", core = "", trail = ""] = /^(\s*)(.*?)(\s*)$/s.exec(text) ?? [];
        return emphasis && core
          ? [
              [false, lead],
              [true, core],
              [false, trail],
            ]
          : [[emphasis, text]];
      })
      .filter(([, text]) => text);
  return [tidy(spans.removed), tidy(spans.added)];
}

/* ── Diff model ────────────────────────────────────────────────────────────── */

interface DiffRow {
  kind: DiffRowKind;
  oldNo?: number;
  newNo?: number;
  text: string;
  spans?: WordSpan[] | undefined;
}

/** Split a change `value` into lines, dropping the empty trailing element. */
function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Flatten change objects into numbered diff rows, word-diffing paired lines. */
function buildRows(changes: Change[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const { kind, value } of changes) {
    for (const text of splitLines(value)) {
      if (kind === "added") rows.push({ kind, newNo: ++newNo, text });
      else if (kind === "removed") rows.push({ kind, oldNo: ++oldNo, text });
      else rows.push({ kind, oldNo: ++oldNo, newNo: ++newNo, text });
    }
  }
  // loom: removed line i pairs with added line i of the same change block.
  for (const { left, right } of pairSplitRows(rows)) {
    if (left?.kind === "removed" && right?.kind === "added") {
      [left.spans, right.spans] = diffWords(left.text, right.text) ?? [];
    }
  }
  return rows;
}

interface SplitRow {
  left?: DiffRow | undefined;
  right?: DiffRow | undefined;
}

/** Pair removed (left) with added (right) rows for side-by-side split view. */
function pairSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind === "context") {
      out.push({ left: rows[i], right: rows[i] });
      i += 1;
      continue;
    }
    const removed: DiffRow[] = [];
    const added: DiffRow[] = [];
    while (i < rows.length && rows[i]!.kind === "removed") removed.push(rows[i++]!);
    while (i < rows.length && rows[i]!.kind === "added") added.push(rows[i++]!);
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1) {
      out.push({ left: removed[k], right: added[k] });
    }
  }
  return out;
}

const ROW_BG: Record<DiffRowKind, string> = {
  added: "bg-emerald-500/10 dark:bg-emerald-500/15",
  removed: "bg-destructive/10",
  context: "",
};
const SIGN_COLOR: Record<DiffRowKind, string> = {
  added: "text-emerald-700 dark:text-emerald-300",
  removed: "text-destructive",
  context: "text-muted-foreground",
};
const SIGN: Record<DiffRowKind, string> = { added: "+", removed: "−", context: " " };
// loom: changed-word emphasis — the diff panel's word-alt mix (`diffRendering.ts`
// `:host`), over this block's card surface.
const emphasisBg = (color: string) =>
  `light-dark(color-mix(in srgb, var(--card) 55%, var(${color})), color-mix(in srgb, var(--card) 45%, var(${color})))`;
const EMPHASIS_BG: Record<DiffRowKind, string | undefined> = {
  added: emphasisBg("--diff-addition"),
  removed: emphasisBg("--diff-deletion"),
  context: undefined,
};
const LINE_NO = "select-none px-2 text-right tabular-nums text-muted-foreground";

const DEFAULT_VISIBLE_DIFF_LINES = 40;

/** Content-stable key for a diff row: its (strictly increasing) line numbers +
 * kind uniquely identify it within a diff, so no array index is needed. */
const rowKey = (row: DiffRow): string => `o${row.oldNo ?? "x"}n${row.newNo ?? "x"}${row.kind[0]}`;
const pairKey = (pair: SplitRow): string =>
  `${pair.left ? rowKey(pair.left) : "x"}|${pair.right ? rowKey(pair.right) : "x"}`;

function parseLineStart(lines: string): number {
  return Number.parseInt(lines.split("-")[0]?.trim() ?? "0", 10) || 0;
}

function DiffLine({
  row,
  side,
  wrap,
  className,
}: {
  row?: DiffRow | undefined;
  side?: "old" | "new" | undefined;
  wrap: boolean;
  className?: string;
}) {
  if (!row) return <div className={cn("min-h-5 bg-muted/30", className)} />;
  const no = side === "old" ? row.oldNo : side === "new" ? row.newNo : undefined;
  const sign = side === "old" ? "−" : side === "new" ? "+" : SIGN[row.kind];
  const showSign = side ? row.kind !== "context" : true;
  return (
    <div className={cn("flex min-h-5 leading-5", ROW_BG[row.kind], className)}>
      {side ? (
        <span className={cn(LINE_NO, "w-[3rem]")}>{no ?? ""}</span>
      ) : (
        <>
          <span className={cn(LINE_NO, "w-[3rem]")}>{row.oldNo ?? ""}</span>
          <span className={cn(LINE_NO, "w-[3rem]")}>{row.newNo ?? ""}</span>
        </>
      )}
      <span
        className={cn("w-5 shrink-0 select-none text-center font-semibold", SIGN_COLOR[row.kind])}
      >
        {showSign ? sign : " "}
      </span>
      <span
        className={cn(
          "px-2 text-foreground",
          wrap ? "min-w-0 flex-1 whitespace-pre-wrap break-words" : "whitespace-pre",
        )}
      >
        {row.spans
          ? row.spans.map(([emphasis, text], index) => (
              <span
                // oxlint-disable-next-line react/no-array-index-key -- static spans; position is identity
                key={index}
                className={emphasis ? "rounded-xs" : undefined}
                style={emphasis ? { backgroundColor: EMPHASIS_BG[row.kind] } : undefined}
              >
                {text}
              </span>
            ))
          : row.text || " "}
      </span>
    </div>
  );
}

function DiffRead({ data, blockId }: PlanBlockReadProps<DiffData>) {
  const rows = useMemo(
    () => buildRows(diffLines(data.before, data.after)),
    [data.before, data.after],
  );
  const [mode, setMode] = useState<DiffMode>(data.mode ?? "split");
  const [showAll, setShowAll] = useState(false);
  const [wrap, setWrap] = useState(data.wrap ?? false);
  const annotations = useMemo(
    () =>
      [...(data.annotations ?? [])].sort(
        (a, b) => parseLineStart(a.lines) - parseLineStart(b.lines),
      ),
    [data.annotations],
  );

  const added = rows.filter((r) => r.kind === "added").length;
  const removed = rows.filter((r) => r.kind === "removed").length;
  const unchanged = data.before === data.after;
  const pairs = useMemo(() => (mode === "split" ? pairSplitRows(rows) : []), [mode, rows]);
  const total = mode === "split" ? pairs.length : rows.length;
  const truncate = !showAll && total > DEFAULT_VISIBLE_DIFF_LINES;
  const shownRows = truncate ? rows.slice(0, DEFAULT_VISIBLE_DIFF_LINES) : rows;
  const shownPairs = truncate ? pairs.slice(0, DEFAULT_VISIBLE_DIFF_LINES) : pairs;

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="diff"
      className="my-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      <figcaption className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-2xs">
        <IconFileDiff className="size-4 shrink-0 text-muted-foreground" />
        <Tooltip>
          <TooltipTrigger
            render={<span className="min-w-0 flex-1 truncate font-mono text-foreground" />}
          >
            {data.filename ?? "diff"}
          </TooltipTrigger>
          <TooltipPopup>{data.filename ?? "diff"}</TooltipPopup>
        </Tooltip>
        <span className="shrink-0 font-mono text-success-foreground">+{added}</span>
        <span className="shrink-0 font-mono text-destructive">−{removed}</span>
        <div className="ml-1 flex shrink-0 overflow-hidden rounded-md border border-border">
          <ModeButton
            active={mode === "unified"}
            onClick={() => setMode("unified")}
            icon={<IconList className="size-3" />}
            label="Unified"
          />
          <ModeButton
            active={mode === "split"}
            onClick={() => setMode("split")}
            icon={<IconColumns className="size-3" />}
            label="Split"
          />
        </div>
        <WrapToggle wrapped={wrap} onToggle={() => setWrap((value) => !value)} />
      </figcaption>

      {unchanged ? (
        <div className="px-4 py-5 text-center font-mono text-xs text-muted-foreground">
          No changes
        </div>
      ) : mode === "split" ? (
        // One CSS grid (1fr 1fr) so each SplitRow pair shares a grid row and its
        // left/right cells stay height-aligned when one side wraps taller. When
        // not wrapping, cells grow to content and the grid scrolls horizontally;
        // when wrapping, `min-w-0 flex-1` on the text span lets cells shrink and
        // wrap. `pairSplitRows`, the truncation button, and annotations are
        // unchanged.
        <div
          className="grid overflow-x-auto font-mono text-xs"
          style={{ gridTemplateColumns: "1fr 1fr" }}
        >
          {shownPairs.map((pair) => (
            <Fragment key={pairKey(pair)}>
              <DiffLine row={pair.left} side="old" wrap={wrap} className="border-r border-border" />
              <DiffLine row={pair.right} side="new" wrap={wrap} />
            </Fragment>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto font-mono text-xs">
          {shownRows.map((row) => (
            <DiffLine key={rowKey(row)} row={row} wrap={wrap} />
          ))}
        </div>
      )}

      {truncate && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full border-t border-border/60 bg-muted/30 px-3 py-1.5 text-left text-2xs text-muted-foreground hover:bg-muted/60"
        >
          Show all {total} lines
        </button>
      )}

      {annotations.length > 0 && (
        <div className="border-t border-border/60 bg-muted/20 px-3 py-2">
          <ol className="flex flex-col gap-2">
            {annotations.map((annotation) => (
              <li
                key={`${annotation.side ?? "after"}-${annotation.lines}-${annotation.label ?? annotation.note}`}
                className="flex gap-2 text-xs"
              >
                <span className="mt-0.5 shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-3xs font-semibold text-muted-foreground">
                  {annotation.side === "before" ? "−" : "+"}L
                  {annotation.lines.replace(/\s*-\s*/, "–")}
                </span>
                <span className="min-w-0 text-foreground">
                  {annotation.label && <span className="font-semibold">{annotation.label}: </span>}
                  <span className={cn(!annotation.label && "text-muted-foreground")}>
                    {annotation.note}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </figure>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1 px-1.5 py-0.5 text-3xs font-medium transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/80",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export const diffBlock: PlanBlock<DiffData> = {
  schema: diffSchema,
  mdx: diffMdx,
  Read: DiffRead,
};
