import { useEffect, useState } from "react";
import { z } from "zod";

import { useTheme } from "~/hooks/useTheme";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { type Tone, toneColor, toneSchema } from "../tones";

/**
 * The `<Mermaid>` block — a Mermaid diagram rendered from its text `source`.
 * The `mermaid` runtime is heavy and browser-only, so it is loaded with a LAZY
 * `await import("mermaid")` that runs ONLY when a Mermaid block actually mounts
 * — it never enters the base bundle. Schema + MDX round-trip ported verbatim
 * from `@agent-native/core` `mermaid.config.ts` (`source`/`caption` flat attrs;
 * `source` a multiline string attr).
 *
 * This is a deliberately slimmer port than BuilderIO's: we drop the optional
 * Excalidraw "sketch" conversion (two extra heavy deps) and render with
 * `securityLevel: "strict"` and `htmlLabels: false` (labels come out as SVG
 * `<text>`, which survives the foreignObject strip below). The rendered SVG is
 * sanitised (scripts, `foreignObject`, event handlers, and `javascript:` URLs
 * stripped) before injection, matching BuilderIO's `sanitizeSvgMarkup`.
 *
 * loom: vocabulary v2 — `look` defaults to Mermaid's crisp `classic` (the July
 * port's `handDrawn` default was a stand-in for the dropped Excalidraw sketch,
 * not a readability choice; it stays as an opt-in). Nodes take the shared tone
 * palette through Mermaid's own class syntax (`A:::tone-risk`, `class A,B
 * tone-neutral`), styled by {@link TONE_THEME_CSS}; `legend` decodes the
 * colours under the figure.
 */

export interface MermaidData {
  source: string;
  caption?: string;
  look?: "classic" | "handDrawn";
  legend?: Array<{ tone: Tone; label: string }>;
}

const mermaidSchema = z.object({
  source: z.string().max(50_000),
  caption: z.string().trim().max(400).optional(),
  look: z.enum(["classic", "handDrawn"]).optional(),
  legend: z
    .array(z.object({ tone: toneSchema, label: z.string().trim().min(1).max(80) }))
    .max(6)
    .optional(),
}) as unknown as z.ZodType<MermaidData>;

const mermaidMdx: BlockMdxConfig<MermaidData> = {
  tag: "Mermaid",
  toAttrs: (data) => ({
    source: data.source,
    caption: data.caption,
    look: data.look,
    legend: data.legend,
  }),
  fromAttrs: (attrs) =>
    ({
      source: attrs.string("source") ?? "",
      caption: attrs.string("caption"),
      look: attrs.string("look"),
      legend: attrs.array("legend"),
    }) as MermaidData,
};

/**
 * Mermaid `themeCSS` mapping a `tone-<name>` node class onto the palette. The
 * SVG is injected inline, so `var(--plan-tone-*)` resolves from the app's
 * `:root`/`.dark` and the colours follow the theme. Selectors mirror the shape
 * elements Mermaid's own `classDef` targets, one class deeper so they outrank
 * the theme's `.node rect`; a `handDrawn` (rough) node is two stroked paths,
 * the fill pattern first, so only its strokes are recoloured. Labels keep the
 * app's foreground for contrast on the soft fill.
 */
export const TONE_THEME_CSS = toneSchema.options
  .map((tone) => {
    const node = `.node.tone-${tone}`;
    const rough = `.rough-node.tone-${tone}`;
    return (
      `${["rect", "polygon", "circle", "ellipse", "path"].map((shape) => `${node} ${shape}`).join(",")}` +
      `{fill:var(--plan-tone-${tone}-soft);stroke:${toneColor(tone)};stroke-width:1.5px}` +
      `${rough} path{stroke:${toneColor(tone)}}` +
      `${rough} path:not(:last-child){stroke:var(--plan-tone-${tone}-soft)}` +
      `${node} .label text,${rough} .label text{fill:var(--foreground)}` +
      `.tone-${tone}.plan-status .label tspan.row+tspan.row{fill:${toneColor(tone)}}`
    );
  })
  .join("\n");

/**
 * The document look every diagram shares, mapped onto the app's tokens so it
 * follows the theme: sans labels in the foreground colour, solid slate edges,
 * and edge labels as small mono text on a card-coloured gap in the line
 * rather than a grey box. A node label written as two lines
 * (`A["name<br/>status"]`, marked `.plan-status` by {@link markStatusNodes})
 * reads as a bold name over a mono status line, which takes the node's tone
 * colour; a long label Mermaid wraps by itself stays one style.
 */
const DOCUMENT_THEME_CSS = [
  `.label text{font-family:var(--font-sans);fill:var(--foreground)}`,
  `.node .label text{font-size:14px}`,
  `.node.plan-status .label tspan.row:first-child>tspan{font-weight:600}`,
  `.node.plan-status .label tspan.row+tspan.row{font-family:var(--font-mono);font-size:12px;fill:var(--muted-foreground);dominant-baseline:central}`,
  `.flowchart-link{stroke:var(--muted-foreground);stroke-width:2px}`,
  `.flowchart-link.edge-pattern-dotted{stroke-dasharray:6 5}`,
  `.marker{fill:var(--muted-foreground);stroke:var(--muted-foreground)}`,
  `.node rect{rx:6px;ry:6px}`,
  `.edgeLabel rect{fill:var(--card);opacity:1;stroke:none}`,
  `.edgeLabel text{font-family:var(--font-mono);font-size:11.5px;fill:var(--muted-foreground)}`,
].join("\n");

/**
 * Mermaid's style grammar rejects `var()`, so an edge is toned by naming the
 * tone as its colour (`linkStyle 5 stroke:tone-risk,color:tone-risk`) and the
 * name is swapped for the palette variable in the rendered SVG — on the path's
 * style, the label's fill, and the arrowhead Mermaid clones per stroke colour.
 */
const TONE_COLOUR_VALUE = new RegExp(
  `((?:stroke|fill|color)(?::\\s*|="))tone-(${toneSchema.options.join("|")})\\b`,
  "g",
);

/**
 * An authored `<br/>` and Mermaid's own wrap render as identical `tspan.row`s,
 * so the flowchart nodes whose label has a `<br/>` get a `plan-status` class
 * (appended `class` statement; unknown ids are ignored by Mermaid) and only
 * they take the name-over-status styling.
 */
function markStatusNodes(source: string): string {
  if (!/^\s*(?:flowchart|graph)\b/m.test(source)) return source;
  const ids = new Set(
    [...source.matchAll(/(\w+)\s*[[({][^\])}\n]*?<br\s*\/?>/gi)].map((match) => match[1]),
  );
  return ids.size > 0 ? `${source}\n  class ${[...ids].join(",")} plan-status` : source;
}

/**
 * Strip scripts / event handlers / javascript: URLs from rendered SVG markup.
 *
 * NOTE: this is deliberately DEFENCE-IN-DEPTH, not the primary trust boundary.
 * Mermaid's own DOMPurify pass over its output (active at `securityLevel:
 * "strict"`, which also disables click/JS interaction) is the real boundary.
 * Beware: in mermaid 11 strict mode does NOT disable `%%{init}%%` directives or
 * HTML labels — we pass `htmlLabels: false` in `renderMermaidSvg` explicitly,
 * because labels rendered as HTML live in `<foreignObject>` and the strip below
 * would delete them (empty boxes). This pass is therefore
 * intentionally lighter than `sanitizeWireframeHtml` (no CSS escape/entity
 * decoding, no `<style>`/containment/viewport handling): the wireframe surface
 * injects raw author HTML with no upstream guard, whereas here Mermaid's own
 * strict renderer produces the markup. Keep it as a cheap second net over the
 * generated output, not a reimplementation of the wireframe sanitiser.
 */
function sanitizeSvgMarkup(svg: string): string {
  if (typeof DOMParser === "undefined") return svg;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  doc.querySelectorAll("script, foreignObject").forEach((node) => node.remove());
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        ((name === "href" || name.endsWith(":href")) && value.startsWith("javascript:"))
      ) {
        element.removeAttribute(attr.name);
      }
    }
  }
  return doc.documentElement.outerHTML;
}

/** Unique id per render invocation. `mermaid.render` deletes any existing DOM
 * elements carrying its id (both its temp body-level container and a previously
 * injected svg), so any id reuse across in-flight renders — two un-id'd blocks,
 * React StrictMode's doubled effects, a theme flip mid-render — makes one
 * render destroy the other's containers and yield an empty/blank diagram. */
let renderSeq = 0;

/** `initialize` sets Mermaid's global config and `render` reads it later, so two
 * blocks with different `look`s rendering at once would swap configs. Each
 * initialize + render pair runs after the previous one settles. */
let renderQueue: Promise<unknown> = Promise.resolve();

export function renderMermaidSvg(
  source: string,
  isDark: boolean,
  look: NonNullable<MermaidData["look"]>,
): Promise<string> {
  const run = renderQueue.then(() => renderNow(source, isDark, look));
  renderQueue = run.catch(() => undefined);
  return run;
}

async function renderNow(
  source: string,
  isDark: boolean,
  look: NonNullable<MermaidData["look"]>,
): Promise<string> {
  const mermaid = (
    (await import("mermaid")) as {
      default: {
        initialize: (config: Record<string, unknown>) => void;
        render: (id: string, source: string) => Promise<{ svg: string }>;
      };
    }
  ).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // SVG <text> labels, NOT <foreignObject> HTML — see sanitizeSvgMarkup note.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // On a draw error mermaid otherwise appends an error graphic + orphaned
    // temp div to document.body (user-visible, accumulating). We render our
    // own error card instead.
    suppressErrorRendering: true,
    look,
    theme: isDark ? "dark" : "neutral",
    themeCSS: `${DOCUMENT_THEME_CSS}\n${TONE_THEME_CSS}`,
  });
  const { svg } = await mermaid.render(`mermaid-render-${++renderSeq}`, markStatusNodes(source));
  return sanitizeSvgMarkup(svg.replace(TONE_COLOUR_VALUE, "$1var(--plan-tone-$2)"));
}

function MermaidRead({ data, blockId }: PlanBlockReadProps<MermaidData>) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const source = data.source.trim();
  const look = data.look ?? "classic";

  useEffect(() => {
    let active = true;
    if (!source) {
      setSvg(null);
      setError(null);
      return;
    }
    void renderMermaidSvg(source, isDark, look)
      .then((rendered) => {
        if (!active) return;
        setSvg(rendered);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : "Failed to render diagram");
      });
    return () => {
      active = false;
    };
  }, [source, isDark, look]);

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="mermaid"
      className="my-4 overflow-hidden rounded-lg border border-border bg-card p-3"
    >
      {error ? (
        <div className="space-y-2">
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs text-foreground">
            {data.source}
          </pre>
          <p className="text-xs text-muted-foreground">Could not render diagram: {error}</p>
        </div>
      ) : svg ? (
        <div
          className="flex justify-center overflow-auto scrollbar-gutter-both [&_svg]:h-auto [&_svg]:max-w-full"
          // Mermaid output is sanitised (sanitizeSvgMarkup) before injection.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="flex min-h-24 items-center justify-center text-xs text-muted-foreground">
          {source ? "Rendering diagram…" : "Empty diagram"}
        </div>
      )}
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
