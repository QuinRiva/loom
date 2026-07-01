import { useMemo } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { sanitizeWireframeHtml } from "../sanitizeWireframeHtml";

/**
 * The `<Screen>` block (Wave C1) — a low-fidelity wireframe artboard rendered
 * from a self-contained, semantic HTML fragment (`html`) inside a surface-locked
 * frame (`surface`). The author writes plain product HTML (`<h1>`, `<button>`,
 * `.wf-card`, `.wf-pill`) using `--wf-*` colour tokens; the renderer owns the
 * surface footprint, the light/dark theme, and the tokens (see
 * `skills/visual-plan/references/wireframe.md`). The rough.js sketch overlay is
 * deferred (D8) — this ships a clean render.
 *
 * SECURITY: `html` is a passed-through JSON string literal the MDX guard never
 * reads, so it is sanitised at THIS render point ({@link sanitizeWireframeHtml})
 * before being injected into the live DOM via `dangerouslySetInnerHTML`.
 *
 * ANNOTATION: the artboard carries `data-plan-block-type="wireframe"` + a
 * `data-plan-block-id`, and every injected element is stamped with a stable
 * `data-wf-node` id ({@link stampWireframeNodes}) — the contract the wireframe
 * node-pin anchor (`anchorForWireframeNode`, Wave A1) consumes.
 */

export type WireframeSurface = "browser" | "desktop" | "mobile" | "popover" | "panel";

/** Fidelity tier (C3). `wireframe` strips host theme classes and imposes the
 * sketch chrome; `design` preserves branded theme classes and renders a clean,
 * neutral frame — the SAME sanitised-HTML-in-live-DOM renderer, one flag. Design
 * stays HTML-only: no authored `css`/`style` field (that would re-open the CSS
 * trust surface the security review closed). */
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

export const screenSchema = z.object({
  surface: z.enum(["browser", "desktop", "mobile", "popover", "panel"]).default("browser"),
  html: z.string().max(200_000),
  caption: z.string().max(500).optional(),
}) as unknown as z.ZodType<ScreenData>;

export const screenMdx: BlockMdxConfig<ScreenData> = {
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
 * Stamp a stable `data-wf-node` id on every element of a sanitised HTML fragment,
 * in document order (`wf-0`, `wf-1`, …) — the wireframe analogue of
 * `assignBlockIds`. Deterministic (same fragment → same ids), so a node-pin
 * anchor survives re-render via its id (and falls back to the structural path
 * otherwise). No-ops without a DOM parser (SSR); the anchor's path fallback covers
 * that. Runs on the injected fragment only — the artboard chrome is untouched.
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
 * Render a sanitised artboard. `flow` (default) gives the standalone `<Screen>`
 * block its document-flow margins + responsive max-width; the canvas `<Artboard>`
 * passes `flow={false}` so the figure sits at its absolute board position with a
 * fixed footprint. The `design` tier preserves theme classes (sanitiser hook)
 * and renders through a neutral surface (`.plan-design-surface`) instead of the
 * wireframe sketch chrome — both surfaces keep the S1 containment box.
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
  const safeHtml = useMemo(
    () => stampWireframeNodes(sanitizeWireframeHtml(data.html, { preserveThemeClasses: design })),
    [data.html, design],
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
 * The `<Design>` block (Wave C3) — the design-fidelity tier: the SAME artboard
 * renderer with `fidelity: "design"` forced, so branded theme classes survive
 * (sanitiser `preserveThemeClasses`) and the render is clean (no sketch chrome),
 * carrying `data-plan-block-type="design"` for A1's node-pin anchoring. It shares
 * `screenSchema` (same surface/html/caption wire shape) — fidelity is implied by
 * the tag, never an attribute, and there is deliberately NO css/style field.
 */
export function DesignRead({ data, blockId }: PlanBlockReadProps<ScreenData>) {
  return <ScreenRead data={{ ...data, fidelity: "design" }} blockId={blockId} />;
}

export const designBlock: PlanBlock<ScreenData> = {
  schema: screenSchema,
  mdx: { ...screenMdx, tag: "Design" },
  Read: DesignRead,
};
