import { useMemo } from "react";
import { z } from "zod";

import type { BlockMdxConfig, MdxAttrValue, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<Diagram>` block — a simple positioned box-and-arrow renderer. Nodes carry
 * `x`/`y` as 0–100 percentages; edges are drawn as SVG arrows between node
 * centres; notes are free-floating labels. No Mermaid / roughjs — this is the
 * lightweight positional graph.
 *
 * Wire contract (ported from `@agent-native/core` `diagram.config.ts`): the graph
 * travels inside a single `data={{ nodes, edges, notes }}` attribute plus a flat
 * `caption`. Internally the data is flat; `toAttrs` re-wraps into `data`,
 * `fromAttrs` spreads it back — so authored `<Diagram data={…} />` round-trips.
 */

export interface DiagramNode {
  id: string;
  label: string;
  detail?: string;
  x?: number;
  y?: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramNote {
  id: string;
  text: string;
  x?: number;
  y?: number;
}

export interface DiagramData {
  caption?: string;
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
  notes?: DiagramNote[];
}

const idSchema = z.string().trim().min(1).max(120);

const nodeSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(160),
  detail: z.string().trim().max(500).optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
}) as z.ZodType<DiagramNode>;

const edgeSchema = z.object({
  from: idSchema,
  to: idSchema,
  label: z.string().trim().max(100).optional(),
}) as z.ZodType<DiagramEdge>;

const noteSchema = z.object({
  id: idSchema,
  text: z.string().trim().min(1).max(500),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
}) as z.ZodType<DiagramNote>;

export const diagramSchema = z.object({
  caption: z.string().trim().max(600).optional(),
  nodes: z.array(nodeSchema).max(80).optional(),
  edges: z.array(edgeSchema).max(120).optional(),
  notes: z.array(noteSchema).max(40).optional(),
}) as unknown as z.ZodType<DiagramData>;

function graphForAttr(data: DiagramData): MdxAttrValue | undefined {
  const graph: Record<string, unknown> = {};
  if (data.nodes?.length) graph.nodes = data.nodes;
  if (data.edges?.length) graph.edges = data.edges;
  if (data.notes?.length) graph.notes = data.notes;
  return Object.keys(graph).length > 0 ? graph : undefined;
}

export const diagramMdx: BlockMdxConfig<DiagramData> = {
  tag: "Diagram",
  toAttrs: (data) => ({
    data: graphForAttr(data),
    caption: data.caption,
  }),
  fromAttrs: (attrs) => {
    const graph = attrs.object<Partial<DiagramData>>("data") ?? {};
    return {
      caption: attrs.string("caption"),
      nodes: graph.nodes,
      edges: graph.edges,
      notes: graph.notes,
    } as DiagramData;
  },
};

/** Fill in coordinates for nodes missing them: spread evenly across a middle row. */
function positioned(nodes: DiagramNode[]): (DiagramNode & { x: number; y: number })[] {
  return nodes.map((node, index) => ({
    ...node,
    x: node.x ?? ((index + 1) / (nodes.length + 1)) * 100,
    y: node.y ?? 50,
  }));
}

export function DiagramRead({ data, blockId }: PlanBlockReadProps<DiagramData>) {
  const nodes = useMemo(() => positioned(data.nodes ?? []), [data.nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edges = data.edges ?? [];
  const notes = data.notes ?? [];

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="diagram"
      className="my-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="relative h-72 w-full">
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            <marker
              id={`arrow-${blockId}`}
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
          {edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            return (
              <line
                key={`${edge.from}-${edge.to}-${edge.label ?? ""}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className="stroke-muted-foreground/60"
                strokeWidth={0.4}
                markerEnd={`url(#arrow-${blockId})`}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to || !edge.label) return null;
          return (
            <span
              key={`label-${edge.from}-${edge.to}-${edge.label}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-card px-1 text-[10px] text-muted-foreground"
              style={{ left: `${(from.x + to.x) / 2}%`, top: `${(from.y + to.y) / 2}%` }}
            >
              {edge.label}
            </span>
          );
        })}

        {nodes.map((node) => (
          <div
            key={node.id}
            data-diagram-node-id={node.id}
            className="absolute max-w-[40%] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background px-3 py-1.5 text-center shadow-sm"
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
          >
            <div className="truncate text-xs font-semibold text-foreground">{node.label}</div>
            {node.detail && (
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{node.detail}</div>
            )}
          </div>
        ))}

        {notes.map((note) => (
          <span
            key={note.id}
            className="absolute max-w-[40%] -translate-x-1/2 -translate-y-1/2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] italic text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
            style={{ left: `${note.x ?? 50}%`, top: `${note.y ?? 90}%` }}
          >
            {note.text}
          </span>
        ))}
      </div>
      {data.caption && (
        <figcaption className="border-t border-border/60 px-3 py-1.5 text-center text-[11px] italic text-muted-foreground">
          {data.caption}
        </figcaption>
      )}
    </figure>
  );
}

export const diagramBlock: PlanBlock<DiagramData> = {
  schema: diagramSchema,
  mdx: diagramMdx,
  Read: DiagramRead,
};
