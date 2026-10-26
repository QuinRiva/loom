import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { sanitizeWireframeHtml } from "../sanitizeWireframeHtml";

/**
 * `<Screen>`: a wireframe artboard from a semantic HTML fragment in a surface frame; the
 * renderer owns footprint, theme and `--wf-*` tokens. `html` passes the MDX guard unread,
 * so it is sanitised HERE ({@link sanitizeWireframeHtml}) before live-DOM injection, and
 * every element is stamped with a `data-wf-node` id for node-pin anchors.
 */

export type WireframeSurface = "browser" | "desktop" | "mobile" | "popover" | "panel";

/** `wireframe` strips host theme classes and adds sketch chrome; `design` keeps branded
 * classes in a neutral frame, through the same sanitised renderer. No authored `css` or
 * `style` field: that would reopen the CSS trust surface. */
export type ScreenFidelity = "wireframe" | "design";

export interface ScreenData {
  surface: WireframeSurface;
  /** Self-contained semantic HTML fragment of the screen (sanitised at render). */
  html: string;
  caption?: string;
  /** Internal render tier (not a `<Screen>` wire attribute — set by the block/
   * tag that renders: `<Screen>`→wireframe, `<Design>`→design, `<Artboard>` per
   * its `fidelity`). */
  fidelity?: ScreenFidelity;
}

/** Surface footprint presets — the frame's width, min-height floor, and corner
 * radius. Width is a `max-width`; the frame shrinks responsively on narrow
 * viewports (no JS fit-scaling — this is a read surface). Values follow
 * BuilderIO's `SURFACE_PRESETS`. */
const SURFACE_PRESETS: Record<
  WireframeSurface,
  { width: number; minHeight: number; radius: number }
> = {
  mobile: { width: 300, minHeight: 360, radius: 30 },
  desktop: { width: 840, minHeight: 200, radius: 14 },
  browser: { width: 900, minHeight: 200, radius: 14 },
  popover: { width: 360, minHeight: 120, radius: 16 },
  panel: { width: 420, minHeight: 200, radius: 16 },
};

const screenSchema = z.object({
  surface: z.enum(["browser", "desktop", "mobile", "popover", "panel"]).default("browser"),
  html: z.string().max(200_000),
  caption: z.string().max(500).optional(),
}) as unknown as z.ZodType<ScreenData>;

const screenMdx: BlockMdxConfig<ScreenData> = {
  tag: "Screen",
  toAttrs: (data) => ({ surface: data.surface, html: data.html, caption: data.caption }),
  fromAttrs: (attrs) =>
    ({
      surface: (attrs.string("surface") as WireframeSurface | undefined) ?? "browser",
      html: attrs.string("html") ?? "",
      caption: attrs.string("caption"),
    }) as ScreenData,
};

/**
 * Stamp `data-wf-node` ids (`wf-0`, `wf-1`, …) on every element of a sanitised fragment
 * in document order, deterministically, so node-pin anchors survive re-render. Without a
 * DOM parser (SSR) it no-ops and anchors fall back to the structural path.
 */
export function stampWireframeNodes(html: string): string {
  if (!html || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let counter = 0;
  doc.body.querySelectorAll<HTMLElement>("*").forEach((el) => {
    if (!el.hasAttribute("data-wf-node")) el.setAttribute("data-wf-node", `wf-${counter}`);
    counter += 1;
  });
  return doc.body.innerHTML;
}

/**
 * Render a sanitised artboard. `flow={false}` (canvas `<Artboard>`) drops the
 * document-flow margins for an absolute board position. Both the sketch and
 * `.plan-design-surface` keep the containment box.
 */
export function ScreenRead({
  data,
  blockId,
  flow = true,
}: PlanBlockReadProps<ScreenData> & { flow?: boolean }) {
  const preset = SURFACE_PRESETS[data.surface] ?? SURFACE_PRESETS.browser;
  const design = data.fidelity === "design";
  // Sanitise (trust boundary) then stamp node ids (annotation contract), memoised
  // on the raw html + tier so both DOM passes only run when either changes. The
  // design tier keeps branded theme classes; the wireframe tier strips them.
  const safeHtml = stampWireframeNodes(
    sanitizeWireframeHtml(data.html, { preserveThemeClasses: design }),
  );

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type={design ? "design" : "wireframe"}
      data-wf-surface={data.surface}
      data-wf-fidelity={design ? "design" : "wireframe"}
      className={cn("wf-artboard", flow && "mx-auto my-6")}
      style={flow ? { width: "100%", maxWidth: preset.width } : { width: preset.width }}
    >
      <div
        className={design ? "plan-design-surface" : "wf-surface"}
        style={{ minHeight: preset.minHeight, borderRadius: preset.radius }}
        dangerouslySetInnerHTML={{ __html: safeHtml }}
      />
      {data.caption ? <figcaption className="wf-caption">{data.caption}</figcaption> : null}
    </figure>
  );
}

export const screenBlock: PlanBlock<ScreenData> = {
  schema: screenSchema,
  mdx: screenMdx,
  Read: ScreenRead,
};

/**
 * `<Design>`: the same artboard renderer with `fidelity: "design"` implied by the tag
 * (never an attribute) and `data-plan-block-type="design"`. Shares `screenSchema`, with
 * deliberately NO css/style field.
 */
export function DesignRead({ data, blockId }: PlanBlockReadProps<ScreenData>) {
  return <ScreenRead data={{ ...data, fidelity: "design" }} blockId={blockId} />;
}

export const designBlock: PlanBlock<ScreenData> = {
  schema: screenSchema,
  mdx: { ...screenMdx, tag: "Design" },
  Read: DesignRead,
};
