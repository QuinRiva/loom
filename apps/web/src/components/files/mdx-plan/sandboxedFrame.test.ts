// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// The authored demo plan, imported raw so the test drives the REAL render
// pipeline against the REAL file (Vite `?raw`).
import demoPlanSource from "../../../../../../plans/mdx-plan-annotation/plan.mdx?raw";

import { anchorForBlockElement, resolveAnchor } from "./annotation/anchoring";
import { assignBlockIds, compilePlanMdx } from "./MdxPlanRenderer";
import {
  buildSrcDoc,
  HTML_CSP,
  HTML_SANDBOX,
  blockLinkActivation,
  HtmlBlockRead,
  inertSrcDoc,
  PROTOTYPE_CSP,
  PROTOTYPE_SANDBOX,
  PrototypeRead,
} from "./blocks/sandboxedFrame";
import { PLAN_BLOCKS, PLAN_BLOCK_COMPONENTS, parsePlanBlock, serializePlanBlock } from "./registry";

/**
 * The sandboxed-iframe surfaces (`<Prototype>` C4, `<HtmlBlock>` B5) are the
 * untrusted-content boundary: the iframe sandbox + `srcdoc` CSP is THE security
 * mechanism (D9). These lock in the exact `sandbox`/CSP invariants a security
 * review depends on — no `allow-same-origin` on the prototype; on HtmlBlock
 * `allow-same-origin` alone (never with scripts), a CSP with no `'self'`, no
 * load-time navigation, and no link activation — plus whole-block annotatability and the MDX wire
 * round-trip.
 */

function parse(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

const renderPrototype = (html = "<p>hi</p>") =>
  parse(renderToStaticMarkup(createElement(PrototypeRead, { data: { html }, blockId: "proto-1" })));
const renderHtmlBlock = (html = "<p>hi</p>") =>
  parse(renderToStaticMarkup(createElement(HtmlBlockRead, { data: { html }, blockId: "html-1" })));

// loom: vocabulary v2 — the theme injection and auto-height must not move the
// boundary: these are the exact strings the security review signed off.
describe("sandboxed frames — the boundary strings are unchanged", () => {
  it("keeps both sandbox and CSP strings byte-identical", () => {
    expect(PROTOTYPE_SANDBOX).toBe("allow-scripts allow-forms");
    expect(HTML_SANDBOX).toBe("allow-same-origin");
    expect(PROTOTYPE_CSP).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; font-src 'self' data:; frame-src 'none'; object-src 'none'; " +
        "base-uri 'none'; form-action 'none'",
    );
    expect(HTML_CSP).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; " +
        "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });
});

describe("sandboxed frames — app theme", () => {
  it("carries the host's resolved tokens and the theme into the srcdoc", () => {
    const root = document.documentElement;
    root.style.setProperty("--foreground", "rgb(1, 2, 3)");
    root.style.setProperty("--plan-tone-risk", "rgb(4, 5, 6)");
    try {
      const dark = buildSrcDoc("<p>hi</p>", HTML_CSP, true);
      expect(dark).toContain('<html class="dark">');
      expect(dark).toContain("color-scheme:dark;");
      expect(dark).toContain("--foreground:rgb(1, 2, 3)");
      expect(dark).toContain("--plan-tone-risk:rgb(4, 5, 6)");
      expect(dark).toContain("body{background:var(--background);color:var(--foreground)");
      // Both surfaces build through it; the CSP meta still leads the head.
      for (const host of [renderHtmlBlock(), renderPrototype()]) {
        const srcdoc = host.querySelector("iframe")!.getAttribute("srcdoc")!;
        expect(srcdoc).toContain("--plan-tone-risk:rgb(4, 5, 6)");
        expect(srcdoc).toContain(
          '<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"',
        );
        expect(srcdoc).toContain("color-scheme:light;");
      }
    } finally {
      root.removeAttribute("style");
    }
  });

  it("sizes an HtmlBlock to its content (clamped) unless a height is given", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = (el: Element) => observed.push(el);
        unobserve() {}
        disconnect() {}
      },
    );
    const mount = (height?: number) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      act(() =>
        root.render(
          createElement(HtmlBlockRead, {
            data: { html: "<p>x</p>", ...(height && { height }) },
            blockId: "html-auto",
          }),
        ),
      );
      const iframe = container.querySelector("iframe")!;
      return { root, iframe };
    };
    const load = (iframe: HTMLIFrameElement, contentHeight: number) => {
      iframe.contentDocument!.documentElement.getBoundingClientRect = () =>
        ({ height: contentHeight }) as DOMRect;
      act(() => iframe.dispatchEvent(new Event("load")));
    };
    try {
      const auto = mount();
      expect(auto.iframe.style.height).toBe(""); // no guessed default
      load(auto.iframe, 131.2);
      expect(auto.iframe.style.height).toBe("132px");
      expect(observed).toEqual([auto.iframe.contentDocument!.documentElement]);
      // A panel-width change resizes the frame's viewport and reflows the content.
      auto.iframe.contentDocument!.documentElement.getBoundingClientRect = () =>
        ({ height: 200 }) as DOMRect;
      act(() => auto.iframe.contentWindow!.dispatchEvent(new Event("resize")));
      expect(auto.iframe.style.height).toBe("200px");
      load(auto.iframe, 9_000);
      expect(auto.iframe.style.height).toBe("4000px");
      act(() => auto.root.unmount());

      const fixed = mount(300);
      load(fixed.iframe, 131);
      expect(fixed.iframe.style.height).toBe("300px"); // an explicit height scrolls
      act(() => fixed.root.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Prototype iframe — interactive but isolated", () => {
  it("uses sandbox 'allow-scripts allow-forms' with NO allow-same-origin", () => {
    const iframe = renderPrototype().querySelector("iframe")!;
    const sandbox = iframe.getAttribute("sandbox")!;
    expect(sandbox).toBe(PROTOTYPE_SANDBOX);
    expect(sandbox).toContain("allow-scripts");
    // The load-bearing isolation invariant: an opaque origin.
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("carries a strict srcdoc CSP: no remote script, no nested frames, locked base/form", () => {
    const srcdoc = renderPrototype().querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(srcdoc).toContain(`content="${PROTOTYPE_CSP}"`);
    expect(PROTOTYPE_CSP).toContain("default-src 'none'");
    expect(PROTOTYPE_CSP).toContain("script-src 'self' 'unsafe-inline'"); // no remote CDNs
    expect(PROTOTYPE_CSP).toContain("frame-src 'none'");
    expect(PROTOTYPE_CSP).toContain("base-uri 'none'");
    expect(PROTOTYPE_CSP).toContain("form-action 'none'");
    expect(PROTOTYPE_CSP).not.toMatch(/https?:/); // no allow-listed remote origin
  });

  it("embeds the author html inside the sandbox srcdoc (never the parent DOM)", () => {
    const host = renderPrototype("<button id='x'>go</button>");
    // The interactive markup lives in the iframe's srcdoc, not the live figure.
    expect(host.querySelector("iframe")!.getAttribute("srcdoc")).toContain(
      "<button id='x'>go</button>",
    );
    expect(host.querySelector("button")).toBeNull();
  });
});

describe("HtmlBlock iframe — static, scripts fully disabled, same-origin", () => {
  it("grants allow-same-origin and NOTHING else (no scripts, forms, popups, navigation)", () => {
    const iframe = renderHtmlBlock().querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe(HTML_SANDBOX);
    // Same-origin is only safe because nothing in the frame can execute.
    expect(HTML_SANDBOX).toBe("allow-same-origin");
  });

  it("carries a no-script CSP that can never reach the app origin", () => {
    const srcdoc = renderHtmlBlock().querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(srcdoc).toContain(`content="${HTML_CSP}"`);
    expect(HTML_CSP).toContain("default-src 'none'");
    expect(HTML_CSP).not.toContain("script-src"); // no script directive at all
    // Same-origin frame: 'self' IS the app, so no directive may allow it.
    expect(HTML_CSP).not.toContain("'self'");
    expect(HTML_CSP).not.toMatch(/https?:/);
  });

  it("strips what navigates the frame on load (CSP has no navigation directive)", () => {
    const srcdoc = renderHtmlBlock(
      `<meta http-equiv="refresh" content="0;url=/api/x"><base href="/">` +
        `<a href="/api/a">a</a><p style="color:red">kept</p>`,
    )
      .querySelector("iframe")!
      .getAttribute("srcdoc")!;
    expect(srcdoc).not.toMatch(/refresh|<base/);
    expect(srcdoc).toContain(`content="${HTML_CSP}"`); // our CSP meta survives
    expect(srcdoc).toContain('<p style="color:red">kept</p>');
    expect(inertSrcDoc(srcdoc)).toBe(srcdoc); // idempotent
  });

  it("cancels every link activation, including links an href strip cannot see", () => {
    const doc = document.implementation.createHTMLDocument();
    blockLinkActivation(doc);
    doc.body.innerHTML =
      `<a href="/api/a">a</a><map><area href="/api/b"></map>` +
      `<svg><a><rect/></a></svg><div id="host"></div>` +
      `<details><summary>s</summary>body</details>`;
    // A link inside a shadow root (what declarative shadow DOM produces).
    const shadow = doc.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<a href="/api/c"><span>c</span></a>`;
    const click = (el: Element) =>
      !el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
      );
    expect(click(doc.querySelector("a")!)).toBe(true);
    expect(click(doc.querySelector("area")!)).toBe(true);
    expect(click(doc.querySelector("rect")!)).toBe(true); // SVG <a>, href set later by SMIL
    expect(click(shadow.querySelector("span")!)).toBe(true);
    expect(click(doc.querySelector("summary")!)).toBe(false); // <details> still toggles
  });
});

describe("sandboxed frames — whole-block annotation", () => {
  it("both hosts are annotatable as one block and round-trip via the visual anchor", () => {
    for (const [render, type] of [
      [renderPrototype, "prototype"],
      [renderHtmlBlock, "html"],
    ] as const) {
      document.body.innerHTML = `<div data-plan-root><h2>Demo</h2>${render().innerHTML}</div>`;
      const root = document.querySelector<HTMLElement>("[data-plan-root]")!;
      assignBlockIds(root);
      const host = root.querySelector(`[data-plan-block-type="${type}"]`)!;
      const { anchor } = anchorForBlockElement(host, root);
      expect(anchor.anchorKind).toBe("visual");
      expect(anchor.blockType).toBe(type);
      expect(resolveAnchor(anchor, root)).not.toBeNull();
    }
  });
});

describe("sandboxed frames — MDX wire round-trip", () => {
  const entryFor = (tag: string) => PLAN_BLOCKS.find((e) => e.tag === tag)!;
  const roundTrip = (tag: string, data: unknown) =>
    parsePlanBlock(entryFor(tag), serializePlanBlock(entryFor(tag), data));

  it("round-trips Prototype and HtmlBlock attributes", () => {
    const proto = { html: "<p>x</p>", caption: "Demo", height: 300 };
    expect(roundTrip("Prototype", proto)).toEqual(proto);
    const html = { html: "<div>y</div>", caption: "Snippet" };
    expect(roundTrip("HtmlBlock", html)).toEqual(html);
  });
});

describe("sandboxed frames — real demo plan renders end-to-end", () => {
  it("compiles plan.mdx (Prototype + HtmlBlock) through the MDX pipeline", async () => {
    const Content = await compilePlanMdx(demoPlanSource); // throws on unknown tag / guard reject
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    expect(html).toContain('data-plan-block-type="prototype"');
    expect(html).toContain('data-plan-block-type="html"');
    // The prototype's inline <script> is confined to the srcdoc, escaped into an attr.
    expect(html).toContain('sandbox="allow-scripts allow-forms"');
    expect(html).toContain('sandbox="allow-same-origin"');
  });
});
