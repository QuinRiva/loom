import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { useTheme } from "~/hooks/useTheme";
import { observeResize } from "~/lib/observeResize";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { toneSchema } from "../tones";

/**
 * `<Prototype>` and `<HtmlBlock>` render author HTML in a sandboxed `<iframe srcdoc>`; the
 * sandbox and CSP strings below ARE the boundary, so the srcdoc is not sanitised and no
 * `postMessage` listener exists. Same-origin HtmlBlock requests would carry app cookies, so
 * CSP, {@link inertSrcDoc} and {@link blockLinkActivation} shut every request path.
 */

/** Prototype iframe sandbox: interactive (scripts + forms) but opaque origin —
 * NO `allow-same-origin`, so the frame cannot touch the parent session. */
export const PROTOTYPE_SANDBOX = "allow-scripts allow-forms";

/** HtmlBlock iframe sandbox: `allow-same-origin` ONLY, so the annotation layer can pin
 * comments inside it. Safe only because without `allow-scripts` nothing in the frame
 * executes; with both, frame script could reach the parent and strip its own sandbox. */
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

/** Strip what navigates the same-origin HtmlBlock frame on load, which CSP cannot stop:
 * `<meta http-equiv>` other than an extra CSP (i.e. `refresh`) and `<base>`. A re-parse
 * confirms serialisation did not resurrect one (mutation XSS); if it did, the frame gets
 * nothing. */
export function inertSrcDoc(srcDoc: string): string {
  // Returns whether anything was stripped.
  const strip = (doc: Document) => {
    const doomed = Array.from(doc.querySelectorAll("meta[http-equiv], base")).filter(
      (el) =>
        el.tagName === "BASE" ||
        el.getAttribute("http-equiv")!.toLowerCase() !== "content-security-policy",
    );
    for (const el of doomed) el.remove();
    return doomed.length > 0;
  };
  const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
  const doc = parse(srcDoc);
  strip(doc);
  const out = `<!doctype html>${doc.documentElement.outerHTML}`;
  return strip(parse(out)) ? "" : out;
}

/** Cancel link activation in an HtmlBlock frame: a capture-phase `click`/`auxclick` whose
 * composed path (crossing shadow roots) passes an HTML or SVG `<a>`/`<area>`. Other clicks
 * keep their default, so `<details>` in a mockup still toggles. */
export function blockLinkActivation(doc: Document): void {
  for (const type of ["click", "auxclick"])
    doc.addEventListener(
      type,
      (event) => {
        // `localName` is undefined on the path's Document/Window entries.
        if (event.composedPath().some((node) => LINK_TAGS.has((node as Element).localName)))
          event.preventDefault();
      },
      true,
    );
}
const LINK_TAGS = new Set(["a", "area"]);

// loom: vocabulary v2 — the app tokens a frame inherits, so a snippet written
// against `var(--plan-tone-risk)` or `var(--foreground)` matches the document
// around it in both themes. Values are resolved from the host at build time
// (a srcdoc document cannot see the parent's stylesheet).
const FRAME_THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--muted",
  "--muted-foreground",
  "--border",
  "--font-sans",
  "--font-mono",
  ...toneSchema.options.flatMap((tone) => [`--plan-tone-${tone}`, `--plan-tone-${tone}-soft`]),
];

/** The host's resolved token values, as declarations for the frame's `:root`. */
function hostTokens(): string {
  if (typeof document === "undefined") return "";
  const computed = getComputedStyle(document.documentElement);
  return FRAME_THEME_TOKENS.flatMap((name) => {
    const value = computed.getPropertyValue(name).trim();
    return value ? [`${name}:${value}`] : [];
  }).join(";");
}

/** Wrap an author HTML fragment in a minimal document carrying the CSP `<meta>`
 * and the host theme (author `<style>` comes later, so it can override). The
 * CSP uses single-quoted keywords, safe to embed in the double-quoted `content`
 * attribute; the fragment itself is confined by the sandbox, not escaped here. */
export function buildSrcDoc(html: string, csp: string, dark: boolean): string {
  // loom: Chromium answers `prefers-color-scheme` inside a frame from the OS, not
  // the app, so an author's `@media (prefers-color-scheme: dark)` is pinned to
  // the app theme: the matching scheme becomes an always-true feature, the other
  // an always-false one.
  html = html.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_, scheme: string) =>
    (scheme.toLowerCase() === "dark") === dark ? "(min-width: 0px)" : "(max-width: -1px)",
  );
  return (
    `<!doctype html><html${dark ? ` class="dark"` : ""}><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>:root{color-scheme:${dark ? "dark" : "light"};${hostTokens()}}html,body{margin:0;padding:0}` +
    `body{background:var(--background);color:var(--foreground);font-family:var(--font-sans,system-ui,sans-serif)}</style>` +
    `</head><body>${html}</body></html>`
  );
}

/** Auto-height bounds for a frame with no explicit `height`. */
const MIN_AUTO_HEIGHT = 48;
const MAX_AUTO_HEIGHT = 4000;

interface SandboxedHtmlFrameProps {
  html: string;
  sandbox: string;
  csp: string;
  /** Run {@link inertSrcDoc} over the document (the same-origin HtmlBlock). */
  inert?: boolean;
  blockType: string;
  blockId: string | undefined;
  title: string;
  /** Fixed height in px (the frame scrolls). Omitted: the frame sizes itself to
   * its content — same-origin frames only (`inert`), the only ones measurable. */
  height: number | undefined;
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
  // A theme flip rebuilds the srcdoc with the new token values (and reloads it).
  const dark = useTheme().resolvedTheme === "dark";
  const doc = buildSrcDoc(html, csp, dark);
  const srcDoc = inert ? inertSrcDoc(doc) : doc;
  // Auto-height: measure the content on load, then again on resize only — the
  // frame's viewport (a panel-width change) or its content (a <details> toggle).
  const [autoHeight, setAutoHeight] = useState<number>();
  const unwatch = useRef<(() => void) | null>(null);
  useEffect(() => () => unwatch.current?.(), []);
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
        // Each srcdoc (re)load is a fresh document, guarded again.
        onLoad={
          inert
            ? (event) => {
                const frame = event.currentTarget;
                const doc = frame.contentDocument;
                if (!doc) return;
                blockLinkActivation(doc);
                if (height !== undefined) return;
                // The root's own box, not scrollHeight (never below the frame's
                // current height, so it could not shrink).
                const measure = () =>
                  setAutoHeight(
                    Math.min(
                      MAX_AUTO_HEIGHT,
                      Math.max(
                        MIN_AUTO_HEIGHT,
                        Math.ceil(doc.documentElement.getBoundingClientRect().height),
                      ),
                    ),
                  );
                measure();
                unwatch.current?.();
                // Not the <iframe> itself: setting its height would re-trigger
                // the observer inside its own callback.
                const view = frame.contentWindow!;
                const unobserve = observeResize(doc.documentElement, measure);
                view.addEventListener("resize", measure);
                unwatch.current = () => {
                  unobserve();
                  view.removeEventListener("resize", measure);
                };
              }
            : undefined
        }
        loading="lazy"
        className="block w-full border-0 bg-background"
        style={{ height: height ?? autoHeight }}
      />
      {caption ? (
        <figcaption className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/* <Prototype> (C4) — interactive sandboxed prototype                          */

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

/* <HtmlBlock> (B5) — static arbitrary-HTML display                            */

export interface HtmlBlockData {
  /** Arbitrary static HTML (rendered with scripts disabled by the sandbox). */
  html: string;
  caption?: string;
  /** Fixed height in px, for a frame that should scroll; omitted, it auto-sizes. */
  height?: number;
}

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
      height={data.height}
      caption={data.caption}
    />
  );
}

export const htmlBlock: PlanBlock<HtmlBlockData> = {
  schema: htmlBlockSchema,
  mdx: htmlBlockMdx,
  Read: HtmlBlockRead,
};
