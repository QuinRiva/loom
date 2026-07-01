import { IconChevronRight } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<Json>` block — a collapsible JSON tree. `json` is the JSON *as a string*
 * (so it round-trips verbatim as a multiline string attribute); `collapsedDepth`
 * sets how deep the tree is open initially. Schema + MDX round-trip ported
 * verbatim from `@agent-native/core` `json-explorer.config.ts`.
 */

export interface JsonData {
  title?: string;
  json: string;
  collapsedDepth?: number;
}

export const jsonSchema = z.object({
  title: z.string().trim().max(200).optional(),
  json: z.string().max(200_000),
  collapsedDepth: z.number().int().min(0).max(20).optional(),
}) as unknown as z.ZodType<JsonData>;

export const jsonMdx: BlockMdxConfig<JsonData> = {
  tag: "Json",
  toAttrs: (data) => ({
    title: data.title,
    json: data.json,
    collapsedDepth: data.collapsedDepth,
  }),
  fromAttrs: (attrs) =>
    ({
      json: attrs.string("json") ?? "",
      title: attrs.string("title"),
      collapsedDepth: attrs.number("collapsedDepth"),
    }) as JsonData,
};

const DEFAULT_COLLAPSED_DEPTH = 2;

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string")
    return <span className="text-emerald-600 dark:text-emerald-300">"{value}"</span>;
  if (typeof value === "number")
    return <span className="text-blue-600 dark:text-blue-300">{value}</span>;
  if (typeof value === "boolean")
    return <span className="text-violet-600 dark:text-violet-300">{String(value)}</span>;
  return <span className="text-muted-foreground">null</span>;
}

function JsonNode({
  name,
  value,
  depth,
  collapsedDepth,
  isLast,
}: {
  name?: string | undefined;
  value: unknown;
  depth: number;
  collapsedDepth: number;
  isLast: boolean;
}) {
  const isContainer = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < collapsedDepth);

  const keyLabel = name !== undefined && <span className="text-foreground">"{name}"</span>;

  if (!isContainer) {
    return (
      <div style={{ paddingLeft: `${depth * 14}px` }} className="whitespace-nowrap">
        {keyLabel}
        {name !== undefined && <span className="text-muted-foreground">: </span>}
        <Scalar value={value} />
        {!isLast && <span className="text-muted-foreground">,</span>}
      </div>
    );
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  const open_ = Array.isArray(value) ? "[" : "{";
  const close = Array.isArray(value) ? "]" : "}";

  return (
    <div>
      <div
        role="button"
        onClick={() => setOpen((current) => !current)}
        className="flex cursor-pointer items-center whitespace-nowrap hover:bg-accent/40"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        <IconChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {keyLabel}
        {name !== undefined && <span className="text-muted-foreground">: </span>}
        <span className="text-muted-foreground">
          {open_}
          {!open && (
            <span className="opacity-70">
              {entries.length}
              {close}
            </span>
          )}
        </span>
      </div>
      {open && (
        <>
          {entries.map(([key, child], index) => (
            <JsonNode
              key={key ?? index}
              name={Array.isArray(value) ? undefined : key}
              value={child}
              depth={depth + 1}
              collapsedDepth={collapsedDepth}
              isLast={index === entries.length - 1}
            />
          ))}
          <div style={{ paddingLeft: `${depth * 14}px` }} className="text-muted-foreground">
            {close}
            {!isLast && <span>,</span>}
          </div>
        </>
      )}
    </div>
  );
}

export function JsonRead({ data, blockId }: PlanBlockReadProps<JsonData>) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(data.json) as unknown };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }, [data.json]);

  return (
    <section
      data-plan-block-id={blockId}
      data-plan-block-type="json-explorer"
      className="my-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      {data.title && (
        <div className="border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {data.title}
        </div>
      )}
      {parsed.ok ? (
        <div className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
          <JsonNode
            value={parsed.value}
            depth={0}
            collapsedDepth={data.collapsedDepth ?? DEFAULT_COLLAPSED_DEPTH}
            isLast
          />
        </div>
      ) : (
        <div className="p-3 text-xs">
          <div className="mb-1 text-destructive">Invalid JSON: {parsed.error}</div>
          <pre className="overflow-x-auto font-mono text-[11px] text-muted-foreground">
            {data.json}
          </pre>
        </div>
      )}
    </section>
  );
}

export const jsonBlock: PlanBlock<JsonData> = {
  schema: jsonSchema,
  mdx: jsonMdx,
  Read: JsonRead,
};
