/*
 * Second trust boundary: wireframe `html` passes the MDX guard as data and is injected
 * into the LIVE page DOM, so raw untrusted HTML is neutralised here. Ported from
 * BuilderIO's `sanitize-html.ts`; it relies on the browser's own parser so obfuscated
 * schemes cannot survive. The regex fallback (SSR) never returns raw HTML.
 */

// SMIL animators can rewrite an `href` to `javascript:` after sanitisation, and `xmp`
// parses its contents as text, hiding `<img onerror>` from the attribute walker.
// Neither has a use in a wireframe, so both are dropped outright.
const BLOCKED_TAGS =
  "script,style,iframe,object,embed,link,meta,base,form,noscript,frame,frameset,applet,marquee,portal,xmp,animate,set,animatetransform,animatemotion,animatecolor";

// Belt-and-braces for B1: HTML-parsed SVG children live in the SVG namespace and
// a type selector *should* match their (lowercase) localName, but we also drop
// them by localName during the attribute walk so a fragile selector can't leave
// a SMIL animator behind.
const BLOCKED_LOCAL_NAMES = new Set([
  "animate",
  "set",
  "animatetransform",
  "animatemotion",
  "animatecolor",
]);

const URL_ATTRS = new Set([
  "href",
  "src",
  "srcset",
  "xlink:href",
  "srcdoc",
  "action",
  "formaction",
  "background",
  "poster",
  "data",
  "ping",
]);

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "ftp:"]);

// The renderer owns these annotation-id namespaces. Foreign HTML carrying them
// would hijack whole-block anchors, node pins and canvas targets (first-match
// `querySelector`), so strip them on the way in, like theme classes.
const RESERVED_ANNOTATION_ATTRS = new Set([
  "data-plan-block-type",
  "data-plan-block-id",
  "data-wf-node",
]);

const WHITESPACE = /\s+/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);/i;

function isSafeUrl(value: string): boolean {
  // Strip whitespace for scheme detection ONLY (the browser collapses these when
  // resolving too, so obfuscated schemes like "java\tscript:" can't hide). The
  // original attribute is left untouched unless we decide to drop it.
  const v = (value || "").replace(WHITESPACE, "");
  if (
    v === "" ||
    v.startsWith("#") ||
    v.startsWith("/") ||
    v.startsWith("./") ||
    v.startsWith("../")
  ) {
    return true;
  }
  if (!HAS_SCHEME.test(v)) return true; // no scheme => relative, safe
  try {
    const a = document.createElement("a");
    a.href = v; // browser decodes the scheme + normalizes
    const proto = a.protocol.toLowerCase();
    // Allow only safe raster data images; block data:image/svg+xml (can script)
    // and data:text/html.
    if (proto === "data:") return SAFE_DATA_IMAGE.test(a.href);
    return SAFE_SCHEMES.has(proto);
  } catch {
    return false;
  }
}

const DANGEROUS_STYLE =
  /(expression\s*\(|javascript:|vbscript:|url\s*\(\s*['"]?\s*(?:javascript|vbscript|data:text\/html))/i;
// Viewport escapes: position:fixed/sticky + huge z-index can lift a mockup out of
// its artboard to overlay the host app. BuilderIO gate this in the CSS-field path;
// we have no CSS field and inject into the live DOM, so we apply it to inline styles.
const DANGEROUS_VIEWPORT_CSS =
  /(?:^|[;{\s])position\s*:\s*(?:fixed|sticky|absolute)\b|(?:^|[;{\s])z-index\s*:\s*[1-9]\d{4,}\b/i;

// Normalise CSS comments (`position/**/:/**/fixed`) and escapes (`\66\69\78\65\64`)
// away before the raw-text style guards test. Defence in depth: `.wf-surface`
// containment traps escaping descendants regardless of any regex bypass.
function cssSafetyText(value: string): string {
  const noComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
  return noComments
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return cp ? String.fromCodePoint(cp) : "";
    })
    .replace(/\\(.)/g, "$1");
}

function isDangerousStyle(value: string): boolean {
  const decoded = cssSafetyText(value);
  return (
    DANGEROUS_STYLE.test(value) ||
    DANGEROUS_STYLE.test(decoded) ||
    DANGEROUS_VIEWPORT_CSS.test(value) ||
    DANGEROUS_VIEWPORT_CSS.test(decoded)
  );
}

type SanitizeElementOptions = {
  stripWireframeThemeClasses?: boolean;
  /** Lint hook: called once per stripped element/attribute with a human-readable
   * reason. Render callers omit it; the plan validator uses it for a dry-run
   * report of what would silently disappear. */
  onStrip?: (message: string) => void;
};

const TAILWIND_THEME_COLORS =
  /^(?:bg|text|border|ring|outline|divide|placeholder|from|via|to|accent|caret|decoration|fill|stroke)-(?:inherit|current|transparent|black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/[\d.]+)?$/;
const TAILWIND_ARBITRARY_THEME_COLOR =
  /^(?:bg|text|border|ring|outline|divide|placeholder|from|via|to|accent|caret|decoration|fill|stroke)-\[/;
const TAILWIND_SHADOW = /^shadow(?:$|-)/;

function baseClassName(className: string): string {
  let bracketDepth = 0;
  let lastVariantSeparator = -1;
  for (let index = 0; index < className.length; index += 1) {
    const char = className[index];
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === ":" && bracketDepth === 0) lastVariantSeparator = index;
  }
  return className.slice(lastVariantSeparator + 1);
}

function isWireframeThemeClass(className: string): boolean {
  const base = baseClassName(className);
  return (
    TAILWIND_THEME_COLORS.test(base) ||
    TAILWIND_ARBITRARY_THEME_COLOR.test(base) ||
    TAILWIND_SHADOW.test(base)
  );
}

function stripThemeClasses(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .filter((className) => !isWireframeThemeClass(className))
    .join(" ");
}

/** Conservative no-DOM fallback for any non-browser code path (SSR). */
function fallbackStrip(html: string, options?: SanitizeElementOptions): string {
  // Drop the whole url attribute if its value (whitespace/control-stripped)
  // carries a dangerous scheme. Mirrors the DOM path for the rare no-DOMParser
  // case; entity-obfuscation isn't decoded here (the live DOM path handles it).
  const stripScheme = (m: string, dq?: string, sq?: string, uq?: string) => {
    // Control chars are stripped deliberately so obfuscated schemes (e.g. an
    // embedded NUL/tab in "java\tscript:") can't hide from the scheme test.
    // eslint-disable-next-line no-control-regex
    const v = (dq ?? sq ?? uq ?? "").replace(/[\s\u0000-\u001f]+/g, "");
    return /^(?:javascript|vbscript):|^data:text\/html/i.test(v) ? "" : m;
  };
  let out = html
    .replace(
      /<\/?(?:script|style|iframe|object|embed|link|meta|base|form|noscript|frame|frameset|applet|marquee|portal|xmp|animate|set|animatetransform|animatemotion|animatecolor)\b[^>]*>/gi,
      "",
    )
    .replace(/\son[a-z][\w:-]*\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // Strip reserved annotation attrs the renderer owns (SF1).
    .replace(
      /\s(?:data-plan-block-type|data-plan-block-id|data-wf-node)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      "",
    )
    .replace(
      /\s(?:href|src|srcset|xlink:href|action|formaction|poster|background|data|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      stripScheme,
    )
    .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, (m) => (isDangerousStyle(m) ? "" : m));
  if (options?.stripWireframeThemeClasses) {
    out = out.replace(
      /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (_match, doubleQuoted, singleQuoted, bare) => {
        const next = stripThemeClasses(doubleQuoted ?? singleQuoted ?? bare ?? "");
        return next ? ` class="${next}"` : "";
      },
    );
  }
  return out;
}

function sanitizeElementAttributes(root: ParentNode, options?: SanitizeElementOptions) {
  root.querySelectorAll<HTMLElement>("*").forEach((el) => {
    if (BLOCKED_LOCAL_NAMES.has(el.localName.toLowerCase())) {
      options?.onStrip?.(`<${el.localName}> element removed (blocked tag)`);
      el.remove();
      return;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || RESERVED_ANNOTATION_ATTRS.has(name)) {
        options?.onStrip?.(
          `"${name}" attribute removed (${name.startsWith("on") ? "event handlers never run in wireframe HTML" : "renderer-owned annotation attribute"})`,
        );
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name) && !isSafeUrl(attr.value)) {
        options?.onStrip?.(`"${name}" attribute removed (unsafe URL scheme)`);
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "style" && isDangerousStyle(attr.value)) {
        const viewport =
          DANGEROUS_VIEWPORT_CSS.test(attr.value) ||
          DANGEROUS_VIEWPORT_CSS.test(cssSafetyText(attr.value));
        options?.onStrip?.(
          viewport
            ? `entire style attribute removed: position:absolute/fixed/sticky and huge z-index are not allowed (ALL declarations in that attribute are lost; use static layout)`
            : `entire style attribute removed (dangerous CSS)`,
        );
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "class" && options?.stripWireframeThemeClasses) {
        const next = stripThemeClasses(attr.value);
        for (const cls of attr.value.split(/\s+/).filter(Boolean).filter(isWireframeThemeClass)) {
          options?.onStrip?.(
            `class "${cls}" stripped (Tailwind theme classes carry no CSS in plans)`,
          );
        }
        if (next) {
          el.setAttribute(attr.name, next);
        } else {
          el.removeAttribute(attr.name);
        }
      }
    }
    if (el instanceof HTMLTemplateElement) {
      sanitizeElementAttributes(el.content, options);
    }
  });
}

/**
 * Neutralise model-authored wireframe HTML at the render point. `preserveThemeClasses`
 * is the design-tier (C3) hook: the wireframe tier strips host/Tailwind theme
 * classes to force the sketch look; the design tier keeps them for branded
 * styling. Only the strip path is exercised today.
 */
export function sanitizeWireframeHtml(
  html: string | undefined,
  options?: { preserveThemeClasses?: boolean; onStrip?: (message: string) => void },
): string {
  if (!html) return "";
  const stripWireframeThemeClasses = !options?.preserveThemeClasses;
  if (typeof DOMParser === "undefined" || typeof document === "undefined") {
    return fallbackStrip(html, { stripWireframeThemeClasses });
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(BLOCKED_TAGS).forEach((el) => {
    options?.onStrip?.(`<${el.localName}> element removed (blocked tag)`);
    el.remove();
  });
  sanitizeElementAttributes(doc.body, {
    stripWireframeThemeClasses,
    ...(options?.onStrip ? { onStrip: options.onStrip } : {}),
  });
  return doc.body.innerHTML;
}
