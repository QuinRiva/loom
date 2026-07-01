import { IconColumns, IconFileDiff, IconList } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<Diff>` block — a GitHub-style before/after line diff, unified or split.
 * The line differ is a small self-contained LCS (`diffLines`) ported verbatim
 * from `@agent-native/core` `DiffBlock.tsx` — NO `jsdiff`/`diff` runtime
 * dependency. Line-anchored `annotations` (mirroring `<AnnotatedCode>`, plus a
 * `side`) render as a note list below the diff. Schema + MDX round-trip ported
 * verbatim from `@agent-native/core` `diff.config.ts` (flat attrs; `before`/
 * `after` multiline string attrs; `annotations` a JSON array attr).
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

export const diffSchema = z.object({
  filename: z.string().trim().max(400).optional(),
  language: z.string().trim().max(40).optional(),
  before: z.string().max(100_000),
  after: z.string().max(100_000),
  mode: z.enum(["unified", "split"]).optional(),
  annotations: z.array(diffAnnotationSchema).max(80).optional(),
}) as unknown as z.ZodType<DiffData>;

export const diffMdx: BlockMdxConfig<DiffData> = {
  tag: "Diff",
  toAttrs: (data) => ({
    filename: data.filename,
    language: data.language,
    mode: data.mode,
    before: data.before,
    after: data.after,
    annotations: data.annotations,
  }),
  fromAttrs: (attrs) =>
    ({
      filename: attrs.string("filename"),
      language: attrs.string("language"),
      mode: attrs.string("mode") as DiffMode | undefined,
      before: attrs.string("before") ?? "",
      after: attrs.string("after") ?? "",
      annotations: attrs.array<DiffAnnotation>("annotations"),
    }) as DiffData,
};

/* ── Inline line differ (LCS) — replaces jsdiff `diffLines` ─────────────────── */

interface Change {
  value: string;
  added?: boolean | undefined;
  removed?: boolean | undefined;
}

const MAX_DIFF_LCS_CELLS = 1_000_000;

/** Split text into lines, each KEEPING its trailing newline. */
function toLineTokens(text: string): string[] {
  if (text === "") return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** A minimal LCS line-level diff producing jsdiff-compatible `Change[]`. */
export function diffLines(before: string, after: string): Change[] {
  const a = toLineTokens(before);
  const b = toLineTokens(after);
  const n = a.length;
  const m = b.length;

  if ((n + 1) * (m + 1) > MAX_DIFF_LCS_CELLS) {
    return [
      ...(before ? [{ value: before, removed: true }] : []),
      ...(after ? [{ value: after, added: true }] : []),
    ];
  }

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
  const push = (value: string, kind: "context" | "added" | "removed") => {
    const last = changes[changes.length - 1];
    const sameKind =
      last &&
      Boolean(last.added) === (kind === "added") &&
      Boolean(last.removed) === (kind === "removed");
    if (sameKind) last!.value += value;
    else
      changes.push({
        value,
        added: kind === "added" ? true : undefined,
        removed: kind === "removed" ? true : undefined,
      });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i]!, "context");
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push(a[i]!, "removed");
      i += 1;
    } else {
      push(b[j]!, "added");
      j += 1;
    }
  }
  while (i < n) push(a[i++]!, "removed");
  while (j < m) push(b[j++]!, "added");
  return changes;
}

/* ── Diff model ────────────────────────────────────────────────────────────── */

type DiffRowKind = "context" | "added" | "removed";

interface DiffRow {
  kind: DiffRowKind;
  oldNo?: number;
  newNo?: number;
  text: string;
}

/** Split a change `value` into lines, dropping the empty trailing element. */
function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Flatten change objects into numbered diff rows. */
function buildRows(changes: Change[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const change of changes) {
    for (const text of splitLines(change.value)) {
      if (change.added) rows.push({ kind: "added", newNo: ++newNo, text });
      else if (change.removed) rows.push({ kind: "removed", oldNo: ++oldNo, text });
      else rows.push({ kind: "context", oldNo: ++oldNo, newNo: ++newNo, text });
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

function DiffLine({ row, side }: { row?: DiffRow | undefined; side?: "old" | "new" | undefined }) {
  if (!row) return <div className="min-h-5 bg-muted/30" />;
  const no = side === "old" ? row.oldNo : side === "new" ? row.newNo : undefined;
  const sign = side === "old" ? "−" : side === "new" ? "+" : SIGN[row.kind];
  const showSign = side ? row.kind !== "context" : true;
  return (
    <div className={cn("flex min-h-5 leading-5", ROW_BG[row.kind])}>
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
      <span className="whitespace-pre px-2 text-foreground">{row.text || " "}</span>
    </div>
  );
}

export function DiffRead({ data, blockId }: PlanBlockReadProps<DiffData>) {
  const rows = useMemo(
    () => buildRows(diffLines(data.before, data.after)),
    [data.before, data.after],
  );
  const [mode, setMode] = useState<DiffMode>(data.mode ?? "split");
  const [showAll, setShowAll] = useState(false);
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
      <figcaption className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[11px]">
        <IconFileDiff className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={data.filename}>
          {data.filename ?? "diff"}
        </span>
        <span className="shrink-0 font-mono text-emerald-700 dark:text-emerald-300">+{added}</span>
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
      </figcaption>

      {unchanged ? (
        <div className="px-4 py-5 text-center font-mono text-xs text-muted-foreground">
          No changes
        </div>
      ) : mode === "split" ? (
        <div className="flex overflow-x-auto font-mono text-xs" data-plan-block-nonprose>
          <div className="min-w-0 flex-1 border-r border-border">
            {shownPairs.map((pair) => (
              <DiffLine key={`old-${pairKey(pair)}`} row={pair.left} side="old" />
            ))}
          </div>
          <div className="min-w-0 flex-1">
            {shownPairs.map((pair) => (
              <DiffLine key={`new-${pairKey(pair)}`} row={pair.right} side="new" />
            ))}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto font-mono text-xs" data-plan-block-nonprose>
          {shownRows.map((row) => (
            <DiffLine key={rowKey(row)} row={row} />
          ))}
        </div>
      )}

      {truncate && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full border-t border-border/60 bg-muted/30 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted/60"
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
                <span className="mt-0.5 shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
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
        "flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium transition-colors",
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
