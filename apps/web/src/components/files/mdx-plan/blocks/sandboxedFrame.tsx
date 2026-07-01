import { useMemo } from "react";
import { z } from "zod";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The two untrusted-content iframe surfaces — `<Prototype>` (C4, interactive)
 * and `<HtmlBlock>` (B5, static). Both render author-supplied HTML inside a
 * **sandboxed `<iframe srcdoc>`**, which is THE security boundary (decision D9):
 * the sandbox gives the frame an opaque (`null`) origin, so it cannot read the
 * parent window/DOM, cookies, or app RPCs — script-in-a-plan can never escalate
 * to the browser session. A strict `srcdoc` CSP `<meta>` is the second belt.
 *
 * Because the sandbox fully isolates the frame, we deliberately do **not** run a
 * redundant HTML sanitiser over the `srcdoc` (D9: "for a fully-isolated sandbox,
 * drop the double-sanitise" — that is exactly the over-defensive coding to
 * avoid). This is the reverse of the wireframe surface, which sanitises because
 * it injects into the *live* DOM. SECURITY REVIEW FOCUS: the `sandbox` + CSP
 * strings below are the entire boundary; see {@link PROTOTYPE_SANDBOX} /
 * {@link HTML_SANDBOX}.
 *
 * The two surfaces differ only in their sandbox capability + CSP:
 *   - Prototype: `allow-scripts allow-forms` (interactive), NO `allow-same-origin`.
 *   - HtmlBlock: `sandbox=""` (fully locked — no scripts run at all).
 *
 * ANNOTATION: the `<figure>` host carries `data-plan-block-type` +
 * `data-plan-block-id`, so the whole surface is annotatable as one block via the
 * existing `visual` (whole-block) anchor path — you cannot select *into* an
 * opaque-origin iframe, so whole-block is the v1 grain (in-frame pins need a
 * postMessage geometry bridge, the deferred C5 tier). Any `postMessage` from the
 * frame is treated as hostile: we register no listener and expose no parent
 * capability in v1.
 */

/** Prototype iframe sandbox: interactive (scripts + forms) but opaque origin —
 * NO `allow-same-origin`, so the frame cannot touch the parent session. */
export const PROTOTYPE_SANDBOX = "allow-scripts allow-forms";

/** HtmlBlock iframe sandbox: fully locked (`sandbox=""`) — no `allow-scripts`,
 * so no JS (inline handlers, `<script>`, `javascript:`) executes at all. */
export const HTML_SANDBOX = "";

/** Prototype `srcdoc` CSP: no remote script (`script-src 'self' 'unsafe-inline'`
 * only), no nested frames, no base/form escape. Interactive inline JS + CSS +
 * data: images only. */
export const PROTOTYPE_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

/** HtmlBlock `srcdoc` CSP: no script at all (no `script-src`; `default-src
 * 'none'` denies it), inline CSS + data: images for static display only. */
export const HTML_CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Wrap an author HTML fragment in a minimal document carrying the CSP `<meta>`.
 * The CSP uses single-quoted keywords, safe to embed in the double-quoted
 * `content` attribute; the fragment itself is confined by the sandbox, not
 * escaped here. */
function buildSrcDoc(html: string, csp: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>html,body{margin:0;padding:0;font-family:system-ui,sans-serif}</style>` +
    `</head><body>${html}</body></html>`
  );
}

interface SandboxedHtmlFrameProps {
  html: string;
  sandbox: string;
  csp: string;
  blockType: string;
  blockId: string | undefined;
  title: string;
  height: number;
  caption: string | undefined;
}

/** The shared sandboxed-iframe host both surfaces render through. */
export function SandboxedHtmlFrame({
  html,
  sandbox,
  csp,
  blockType,
  blockId,
  title,
  height,
  caption,
}: SandboxedHtmlFrameProps) {
  const srcDoc = useMemo(() => buildSrcDoc(html, csp), [html, csp]);
  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type={blockType}
      className="my-6 overflow-hidden rounded-lg border border-border bg-background"
    >
      <iframe
        title={title}
        sandbox={sandbox}
        srcDoc={srcDoc}
        loading="lazy"
        className="block w-full border-0 bg-white"
        style={{ height }}
      />
      {caption ? (
        <figcaption className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* <Prototype> (C4) — interactive sandboxed prototype                          */
/* -------------------------------------------------------------------------- */

export interface PrototypeData {
  /** Self-contained interactive HTML/JS document (runs in the opaque-origin sandbox). */
  html: string;
  caption?: string;
  /** Rendered iframe height in px (the frame does not auto-size across the
   * opaque-origin boundary without a postMessage bridge). */
  height?: number;
}

const PROTOTYPE_DEFAULT_HEIGHT = 420;

export const prototypeSchema = z.object({
  html: z.string().max(500_000),
  caption: z.string().max(500).optional(),
  height: z.number().int().positive().max(4000).optional(),
}) as unknown as z.ZodType<PrototypeData>;

const prototypeMdx: BlockMdxConfig<PrototypeData> = {
  tag: "Prototype",
  toAttrs: (data) => ({ html: data.html, caption: data.caption, height: data.height }),
  fromAttrs: (attrs) =>
    ({
      html: attrs.string("html") ?? "",
      caption: attrs.string("caption"),
      height: attrs.number("height"),
    }) as PrototypeData,
};

export function PrototypeRead({ data, blockId }: PlanBlockReadProps<PrototypeData>) {
  return (
    <SandboxedHtmlFrame
      html={data.html}
      sandbox={PROTOTYPE_SANDBOX}
      csp={PROTOTYPE_CSP}
      blockType="prototype"
      blockId={blockId}
      title={data.caption ?? "Interactive prototype"}
      height={data.height ?? PROTOTYPE_DEFAULT_HEIGHT}
      caption={data.caption}
    />
  );
}

export const prototypeBlock: PlanBlock<PrototypeData> = {
  schema: prototypeSchema,
  mdx: prototypeMdx,
  Read: PrototypeRead,
};

/* -------------------------------------------------------------------------- */
/* <HtmlBlock> (B5) — static arbitrary-HTML display                            */
/* -------------------------------------------------------------------------- */

export interface HtmlBlockData {
  /** Arbitrary static HTML (rendered with scripts disabled by the sandbox). */
  html: string;
  caption?: string;
  height?: number;
}

const HTML_DEFAULT_HEIGHT = 240;

export const htmlBlockSchema = z.object({
  html: z.string().max(500_000),
  caption: z.string().max(500).optional(),
  height: z.number().int().positive().max(4000).optional(),
}) as unknown as z.ZodType<HtmlBlockData>;

const htmlBlockMdx: BlockMdxConfig<HtmlBlockData> = {
  // BuilderIO's block is internally `custom-html`; our MDX component tag is
  // `HtmlBlock` (PascalCase, matching every other plan tag).
  tag: "HtmlBlock",
  toAttrs: (data) => ({ html: data.html, caption: data.caption, height: data.height }),
  fromAttrs: (attrs) =>
    ({
      html: attrs.string("html") ?? "",
      caption: attrs.string("caption"),
      height: attrs.number("height"),
    }) as HtmlBlockData,
};

export function HtmlBlockRead({ data, blockId }: PlanBlockReadProps<HtmlBlockData>) {
  return (
    <SandboxedHtmlFrame
      html={data.html}
      sandbox={HTML_SANDBOX}
      csp={HTML_CSP}
      blockType="html"
      blockId={blockId}
      title={data.caption ?? "Embedded HTML"}
      height={data.height ?? HTML_DEFAULT_HEIGHT}
      caption={data.caption}
    />
  );
}

export const htmlBlock: PlanBlock<HtmlBlockData> = {
  schema: htmlBlockSchema,
  mdx: htmlBlockMdx,
  Read: HtmlBlockRead,
};
