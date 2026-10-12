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
 * The two surfaces differ in their sandbox capability + CSP:
 *   - Prototype: `allow-scripts allow-forms` (interactive), NO `allow-same-origin`.
 *   - HtmlBlock: `allow-same-origin` and NOTHING else — no scripts run at all, but
 *     the host can read the frame's DOM so a reviewer can comment on one card.
 *
 * ANNOTATION: the `<figure>` host carries `data-plan-block-type` +
 * `data-plan-block-id`, so either surface is annotatable as one block via the
 * `visual` (whole-block) anchor path. A Prototype's opaque-origin frame cannot be
 * selected into, so that is its finest grain. An HtmlBlock frame is same-origin,
 * so the annotation layer listens inside it and pins a selection to the card it
 * was made in (`anchorForFrameRange` in `annotation/anchoring.ts`). Any
 * `postMessage` from either frame is treated as hostile: we register no listener.
 *
 * WHY SAME-ORIGIN IS SAFE FOR HtmlBlock (and only HtmlBlock). `allow-same-origin`
 * is dangerous with `allow-scripts` (frame script could reach the parent and
 * strip its own sandbox). Without `allow-scripts` nothing in the frame ever
 * executes — no `<script>`, handler, `javascript:` URL — so the only actor in
 * that origin is OUR host code, which only reads text and geometry. What
 * same-origin DOES change is that the frame's own requests become same-site,
 * credentialed requests to the app (cookies ride along), so every way static
 * HTML can make a request must be shut — CSP for fetches, a parse pass
 * ({@link inertSrcDoc}) for the navigations CSP has no directive for:
 *   - subresources (`<img>`, `<link>`, CSS `url()` / `@import` / `@font-face`,
 *     `<video>`/`<audio>`, `<object>`, nested frames, SVG `<image>`/`<use>`):
 *     {@link HTML_CSP} — `default-src 'none'`, only `data:` images/fonts and
 *     inline styles, and crucially no `'self'` (which now means the app);
 *   - `<form action>`: no `allow-forms`, plus `form-action 'none'`;
 *   - `<base href>`: `base-uri 'none'` (and stripped);
 *   - `<meta http-equiv="refresh">` (self-navigation on load): stripped;
 *   - link clicks (`<a href>`, `<area>`, SVG `<a>`, any `target`): every
 *     non-fragment `href` is stripped, and there is no `allow-popups` /
 *     `allow-top-navigation` for a `target` to use anyway.
 */

/** Prototype iframe sandbox: interactive (scripts + forms) but opaque origin —
 * NO `allow-same-origin`, so the frame cannot touch the parent session. */
export const PROTOTYPE_SANDBOX = "allow-scripts allow-forms";

/** HtmlBlock iframe sandbox: `allow-same-origin` ONLY — no `allow-scripts`, so no
 * JS (inline handlers, `<script>`, `javascript:`) executes at all; same-origin so
 * the annotation layer can pin comments inside it (see the header comment). */
export const HTML_SANDBOX = "allow-same-origin";

/** Prototype `srcdoc` CSP: no remote script (`script-src 'self' 'unsafe-inline'`
 * only), no nested frames, no base/form escape. Interactive inline JS + CSS +
 * data: images only. */
export const PROTOTYPE_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

/** HtmlBlock `srcdoc` CSP: no script at all (no `script-src`; `default-src
 * 'none'` denies it), inline CSS + data: images/fonts for static display only.
 * No `'self'` anywhere: the frame is same-origin, so `'self'` would be the app. */
export const HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; " +
  "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Strip what can navigate the same-origin HtmlBlock frame (CSP has no navigation
 * directive): every `<meta http-equiv>` except an extra CSP (which can only
 * tighten), `<base>`, and every non-fragment `href` / `xlink:href` (links, image
 * maps, SVG `<a>`/`<use>`). Parsed with the inert `DOMParser` (no fetch, no
 * script), then re-parsed to confirm the serialisation did not resurrect one
 * (mutation-XSS style) — if it did, the frame gets nothing. */
export function inertSrcDoc(srcDoc: string): string {
  // Returns whether anything was stripped.
  const strip = (doc: Document) => {
    const doomed = [
      ...Array.from(doc.querySelectorAll("meta[http-equiv], base")).filter(
        (el) =>
          el.tagName === "BASE" ||
          el.getAttribute("http-equiv")!.toLowerCase() !== "content-security-policy",
      ),
      ...Array.from(doc.querySelectorAll("*"), (el) =>
        Array.from(el.attributes).filter(
          (attr) => attr.localName === "href" && !attr.value.trim().startsWith("#"),
        ),
      ).flat(),
    ];
    for (const node of doomed) {
      if (node instanceof Attr) node.ownerElement?.removeAttributeNode(node);
      else node.remove();
    }
    return doomed.length > 0;
  };
  const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
  const doc = parse(srcDoc);
  strip(doc);
  const out = `<!doctype html>${doc.documentElement.outerHTML}`;
  return strip(parse(out)) ? "" : out;
}

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
  /** Run {@link inertSrcDoc} over the document (the same-origin HtmlBlock). */
  inert?: boolean;
  blockType: string;
  blockId: string | undefined;
  title: string;
  height: number;
  caption: string | undefined;
}

/** The shared sandboxed-iframe host both surfaces render through. */
function SandboxedHtmlFrame({
  html,
  sandbox,
  csp,
  inert,
  blockType,
  blockId,
  title,
  height,
  caption,
}: SandboxedHtmlFrameProps) {
  const srcDoc = useMemo(() => {
    const doc = buildSrcDoc(html, csp);
    return inert ? inertSrcDoc(doc) : doc;
  }, [html, csp, inert]);
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

const prototypeSchema = z.object({
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

const htmlBlockSchema = z.object({
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
      inert
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
