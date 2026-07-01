import { useEffect, useState } from "react";
import { z } from "zod";

import { useTheme } from "~/hooks/useTheme";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

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
 * Mermaid's own `handDrawn` look + `securityLevel: "strict"`. The rendered SVG
 * is sanitised (scripts, `foreignObject`, event handlers, and `javascript:`
 * URLs stripped) before injection, matching BuilderIO's `sanitizeSvgMarkup`.
 */

export interface MermaidData {
  source: string;
  caption?: string;
}

export const mermaidSchema = z.object({
  source: z.string().max(50_000),
  caption: z.string().trim().max(400).optional(),
}) as unknown as z.ZodType<MermaidData>;

export const mermaidMdx: BlockMdxConfig<MermaidData> = {
  tag: "Mermaid",
  toAttrs: (data) => ({ source: data.source, caption: data.caption }),
  fromAttrs: (attrs) =>
    ({
      source: attrs.string("source") ?? "",
      caption: attrs.string("caption"),
    }) as MermaidData,
};

/**
 * Strip scripts / event handlers / javascript: URLs from rendered SVG markup.
 *
 * NOTE: this is deliberately DEFENCE-IN-DEPTH, not the primary trust boundary.
 * Mermaid `securityLevel: "strict"` (set in `renderMermaidSvg`) is the real
 * boundary — it disables `%%{init}%%` directives, HTML labels, and click/JS
 * interaction, so the SVG we receive is already benign. This pass is therefore
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

async function renderMermaidSvg(source: string, id: string, isDark: boolean): Promise<string> {
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
    look: "handDrawn",
    theme: isDark ? "dark" : "neutral",
  });
  const { svg } = await mermaid.render(id, source);
  return sanitizeSvgMarkup(svg);
}

export function MermaidRead({ data, blockId }: PlanBlockReadProps<MermaidData>) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const source = data.source.trim();
    if (!source) {
      setSvg(null);
      setError(null);
      return;
    }
    // A DOM-id-safe render id (mermaid requires a valid CSS id).
    const renderId = `mermaid-${(blockId ?? "block").replace(/[^a-zA-Z0-9_-]/g, "-")}-${isDark ? "d" : "l"}`;
    void renderMermaidSvg(source, renderId, isDark)
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
  }, [data.source, blockId, isDark]);

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="mermaid"
      className="my-4 overflow-hidden rounded-lg border border-border bg-card p-3"
    >
      {error ? (
        <div className="space-y-2">
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] text-foreground">
            {data.source}
          </pre>
          <p className="text-xs text-muted-foreground">Could not render diagram: {error}</p>
        </div>
      ) : svg ? (
        <div
          className="flex justify-center overflow-auto [&_svg]:h-auto [&_svg]:max-w-full"
          // Mermaid output is sanitised (sanitizeSvgMarkup) before injection.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="flex min-h-24 items-center justify-center text-xs text-muted-foreground">
          Rendering diagram…
        </div>
      )}
      {data.caption && (
        <figcaption className="mt-2 text-center text-[11px] italic text-muted-foreground">
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
