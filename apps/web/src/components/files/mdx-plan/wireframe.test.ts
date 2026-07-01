// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { anchorForWireframeNode, resolveAnchor } from "./annotation/anchoring";
import { assignBlockIds } from "./MdxPlanRenderer";
import { ScreenRead, stampWireframeNodes } from "./blocks/screen";
import { sanitizeWireframeHtml } from "./sanitizeWireframeHtml";

/**
 * The wireframe surface is the SECOND trust boundary of the MDX-plan vertical:
 * `html` is a passed-through string literal the MDX guard never reads, sanitised
 * only at the block render point before live-DOM injection. These exercise the
 * same exploit-shape rigour as the MDX guard's `mdxPlan.test.ts` — a hole here
 * runs arbitrary browser JS from an authored `.mdx`. They also cover the
 * `data-wf-node` stamping contract the Wave A1 node-pin anchor consumes.
 */

/** Parse a sanitised fragment into a live DOM to assert over structure. */
function parse(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("sanitizeWireframeHtml — dangerous elements", () => {
  it("drops script/style/iframe/object/embed/link/meta/base/form/noscript", () => {
    const dirty =
      "<div>ok<script>globalThis.__pwned=1</script>" +
      "<style>body{display:none}</style><iframe src='x'></iframe>" +
      "<object data='x'></object><embed src='x'>" +
      "<link rel='stylesheet' href='x'><meta http-equiv='refresh'>" +
      "<base href='//evil'><form action='//evil'></form>" +
      "<noscript>n</noscript></div>";
    const clean = sanitizeWireframeHtml(dirty);
    for (const tag of [
      "<script",
      "<style",
      "<iframe",
      "<object",
      "<embed",
      "<link",
      "<meta",
      "<base",
      "<form",
      "<noscript",
    ]) {
      expect(clean).not.toContain(tag);
    }
    expect(clean).toContain("ok"); // benign content survives
  });
});

describe("sanitizeWireframeHtml — event handlers", () => {
  it("strips every on* handler attribute", () => {
    const clean = sanitizeWireframeHtml(
      "<button onclick=\"steal()\" onmouseover='x()'>hi</button>" +
        "<img src='data:image/png;base64,x' onerror='pwn()' />",
    );
    expect(clean).not.toMatch(/on\w+=/i);
    expect(clean).toContain("hi");
  });
});

describe("sanitizeWireframeHtml — unsafe URL schemes", () => {
  it("strips javascript: and obfuscated variants but keeps safe URLs", () => {
    const el = parse(
      sanitizeWireframeHtml(
        "<a href='javascript:alert(1)'>a</a>" +
          "<a href='java\tscript:alert(1)'>b</a>" + // whitespace-obfuscated
          "<a href='&#106;avascript:alert(1)'>c</a>" + // entity-obfuscated
          "<a href='https://ok.example'>d</a>" +
          "<a href='#anchor'>e</a>" +
          "<a href='/rel/path'>f</a>",
      ),
    );
    const hrefs = Array.from(el.querySelectorAll("a"), (a) => a.getAttribute("href"));
    // First three (all javascript:) dropped → null; safe ones retained.
    expect(hrefs.slice(0, 3)).toEqual([null, null, null]);
    expect(hrefs.slice(3)).toEqual(["https://ok.example", "#anchor", "/rel/path"]);
  });

  it("blocks data:text/html and data:image/svg+xml but allows raster data images", () => {
    const el = parse(
      sanitizeWireframeHtml(
        "<a href='data:text/html,<script>x</script>'>h</a>" +
          "<img src='data:image/svg+xml,<svg onload=1>' />" +
          "<img src='data:image/png;base64,iVBORw0KGgo=' />",
      ),
    );
    expect(el.querySelector("a")?.getAttribute("href")).toBeNull();
    const imgs = Array.from(el.querySelectorAll("img"), (i) => i.getAttribute("src"));
    expect(imgs[0]).toBeNull(); // svg+xml can script
    expect(imgs[1]).toContain("data:image/png"); // raster kept
  });
});

describe("sanitizeWireframeHtml — dangerous inline styles", () => {
  it("strips expression()/javascript: and viewport escapes (position:fixed, huge z-index)", () => {
    const el = parse(
      sanitizeWireframeHtml(
        "<div style='width:expression(alert(1))'>a</div>" +
          "<div style='background:url(javascript:alert(1))'>b</div>" +
          "<div style='position:fixed;inset:0;z-index:99999'>c</div>" +
          "<div style='position:sticky;top:0'>d</div>" +
          "<div style='color:var(--wf-ink);padding:8px'>e</div>",
      ),
    );
    const styles = Array.from(el.querySelectorAll("div"), (d) => d.getAttribute("style"));
    expect(styles.slice(0, 4)).toEqual([null, null, null, null]); // all dangerous → dropped
    expect(styles[4]).toContain("var(--wf-ink)"); // benign style kept
  });
});

describe("sanitizeWireframeHtml — theme-class leakage", () => {
  it("strips host/Tailwind theme classes by default, keeps them under preserveThemeClasses (C3 hook)", () => {
    const dirty = "<div class='wf-card bg-white text-zinc-950 shadow-xl'>x</div>";
    const stripped = parse(sanitizeWireframeHtml(dirty)).querySelector("div")!;
    expect(stripped.className).toBe("wf-card"); // theme colours + shadow removed
    const preserved = parse(
      sanitizeWireframeHtml(dirty, { preserveThemeClasses: true }),
    ).querySelector("div")!;
    expect(preserved.className).toContain("bg-white");
    expect(preserved.className).toContain("shadow-xl");
  });
});

const SIGN_IN =
  "<div style='padding:16px'><h1>Sign in</h1>" +
  "<button class='primary'>Continue</button>" +
  "<script>globalThis.__pwned=1</script></div>";

describe("<Screen> render", () => {
  it("renders a sanitised artboard with the surface + annotation contract attributes", () => {
    const html = renderToStaticMarkup(
      createElement(ScreenRead, { data: { surface: "browser", html: SIGN_IN }, blockId: "wf-1" }),
    );
    const el = parse(html);
    const artboard = el.querySelector('[data-plan-block-type="wireframe"]')!;
    expect(artboard).not.toBeNull();
    expect(artboard.getAttribute("data-plan-block-id")).toBe("wf-1");
    expect(artboard.getAttribute("data-wf-surface")).toBe("browser");
    expect(html).not.toContain("<script"); // sanitised at the render point
    expect(html).toContain("Sign in");
  });

  it("omits data-plan-block-id when the author gives no id (S1 pattern)", () => {
    const html = renderToStaticMarkup(
      createElement(ScreenRead, {
        data: { surface: "mobile", html: "<h1>x</h1>" },
        blockId: undefined,
      }),
    );
    expect(html).not.toContain('data-plan-block-id=""');
  });
});

describe("stampWireframeNodes", () => {
  it("stamps a stable, distinct data-wf-node on every element in document order", () => {
    const el = parse(stampWireframeNodes("<div><h1>t</h1><button>b</button></div>"));
    const ids = Array.from(el.querySelectorAll("*"), (n) => n.getAttribute("data-wf-node"));
    expect(ids).toEqual(["wf-0", "wf-1", "wf-2"]);
    // Deterministic: identical fragment → identical ids.
    expect(stampWireframeNodes("<div><h1>t</h1><button>b</button></div>")).toBe(el.innerHTML);
  });
});

describe("wireframe artboard ↔ Wave A1 node-pin anchor (end-to-end)", () => {
  it("A1's anchorForWireframeNode captures + resolves against a rendered <Screen>", () => {
    document.body.innerHTML = `<div data-plan-root>${renderToStaticMarkup(
      createElement(ScreenRead, {
        data: { surface: "browser", html: SIGN_IN },
        blockId: undefined,
      }),
    )}</div>`;
    const root = document.querySelector<HTMLElement>("[data-plan-root]")!;
    assignBlockIds(root); // fills the artboard's data-plan-block-id (no authored id)

    const button = root.querySelector("button")!;
    expect(button.hasAttribute("data-wf-node")).toBe(true); // stamped in the render

    const pin = anchorForWireframeNode(button, root)!;
    expect(pin.anchor.anchorKind).toBe("wireframe");
    expect(pin.anchor.targetKind).toBe("wireframe");
    expect(pin.anchor.targetNodeId).toBe(button.getAttribute("data-wf-node"));
    // targetSelector points at the assignBlockIds-filled artboard id.
    expect(pin.anchor.targetSelector).toContain("data-plan-block-id");

    const resolved = resolveAnchor(pin.anchor, root);
    expect(resolved?.toString()).toContain("Continue");
  });
});
