import DOMPurify from "dompurify";
import type { Mounted } from "pele/lazy";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { type Tone, toneColor, toneSchema } from "../tones";

/**
 * `<Mermaid>`, drawn by the `pele` renderer the chat uses, loaded on mount. Nodes take
 * the shared tone palette via Mermaid class syntax (`A:::tone-risk`), styled by the
 * `.plan-mermaid` rules in `index.css`; pele's own CSS variables follow the app theme.
 */

export interface MermaidData {
  source: string;
  caption?: string;
  legend?: Array<{ tone: Tone; label: string }>;
}

const mermaidSchema = z.object({
  source: z.string().max(50_000),
  caption: z.string().trim().max(400).optional(),
  legend: z
    .array(z.object({ tone: toneSchema, label: z.string().trim().min(1).max(80) }))
    .max(6)
    .optional(),
}) as unknown as z.ZodType<MermaidData>;

const mermaidMdx: BlockMdxConfig<MermaidData> = {
  tag: "Mermaid",
  toAttrs: (data) => ({ source: data.source, caption: data.caption, legend: data.legend }),
  fromAttrs: (attrs) =>
    ({
      source: attrs.string("source") ?? "",
      caption: attrs.string("caption"),
      legend: attrs.array("legend"),
    }) as MermaidData,
};

/**
 * Mermaid's style grammar rejects `var()`, so an edge is toned by naming the
 * tone as its colour (`linkStyle 5 stroke:tone-risk,color:tone-risk`) and the
 * name is swapped for the palette variable in the rendered SVG: on the edge's
 * style, its label's fill, and its arrowhead.
 */
const TONE_COLOUR_VALUE = new RegExp(
  `((?:stroke|fill|color)(?::\\s*|="))tone-(${toneSchema.options.join("|")})\\b`,
  "g",
);

/**
 * An authored `<br/>` and a wrapped label render as identical `tspan`s, so the
 * flowchart nodes whose label has a `<br/>` get a `plan-status` class (appended
 * `class` statement; unknown ids are ignored) and only they take the
 * name-over-status styling.
 */
export function markStatusNodes(source: string): string {
  if (!/^\s*(?:flowchart|graph)\b/m.test(source)) return source;
  const ids = new Set(
    [...source.matchAll(/(\w+)\s*[[({][^\])}\n]*?<br\s*\/?>/gi)].map((match) => match[1]),
  );
  return ids.size > 0 ? `${source}\n  class ${[...ids].join(",")} plan-status` : source;
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

// Same policy as the chat's MermaidDiagram: pele escapes labels and links and
// images are off, so this is defence in depth.
export function sanitizeDiagramSvg(svg: string): Node {
  purifier ??= DOMPurify(window);
  return purifier.sanitize(svg.replace(TONE_COLOUR_VALUE, "$1var(--plan-tone-$2)"), {
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "image", "foreignObject", "style"],
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
  });
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Failed to render diagram";

function MermaidRead({ data, blockId }: PlanBlockReadProps<MermaidData>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const source = data.source.trim();
  // Keyed by source so an edit shows "Rendering…" rather than the old outcome.
  const [outcome, setOutcome] = useState<{ source: string; error: string | null } | null>(null);
  const settled = outcome?.source === source ? outcome : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !source) return;
    let active = true;
    let mounted: Mounted | undefined;
    const report = (error: string | null) => {
      if (active) setOutcome({ source, error });
    };
    const text = markStatusNodes(source);
    // Load first and mount synchronously only while still current, so a superseded
    // render (StrictMode, a source edit) never draws into or clears the container.
    import("pele/lazy")
      .then(async (pele) => {
        await pele.load(pele.detectType(text));
        if (!active) return;
        mounted = pele.mount(container, text, {
          links: false,
          images: false,
          zoom: false,
          // Keep the author's direction; a wide diagram scales down to fit instead of turning vertical.
          autoDirection: false,
          sanitize: sanitizeDiagramSvg,
          onRender: () => report(null),
          onError: (error) => report(errorMessage(error)),
        });
      })
      .catch((error: unknown) => report(errorMessage(error)));
    return () => {
      active = false;
      mounted?.destroy();
    };
  }, [source]);

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="mermaid"
      className="plan-mermaid my-4 overflow-hidden rounded-lg border border-border bg-card p-3"
    >
      {settled?.error ? (
        <div className="space-y-2">
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs text-foreground">
            {data.source}
          </pre>
          <p className="text-xs text-muted-foreground">Could not render diagram: {settled.error}</p>
        </div>
      ) : settled ? null : (
        <div className="flex min-h-24 items-center justify-center text-xs text-muted-foreground">
          {source ? "Rendering diagram…" : "Empty diagram"}
        </div>
      )}
      <div
        ref={containerRef}
        hidden={!source || !!settled?.error}
        className="flex justify-center overflow-auto scrollbar-gutter-both"
      />
      {data.legend?.length ? (
        <ul className="plan-mermaid-legend">
          {data.legend.map(({ tone, label }) => (
            <li key={label}>
              <span
                aria-hidden
                className="plan-mermaid-swatch"
                style={{
                  background: `var(--plan-tone-${tone}-soft)`,
                  borderColor: toneColor(tone),
                }}
              />
              {label}
            </li>
          ))}
        </ul>
      ) : null}
      {data.caption && (
        <figcaption className="mt-2 text-center text-2xs italic text-muted-foreground">
          {data.caption}
        </figcaption>
      )}
    </figure>
  );
}

export const mermaidBlock: PlanBlock<MermaidData> = {
  schema: mermaidSchema,
  mdx: mermaidMdx,
  Read: MermaidRead,
};
