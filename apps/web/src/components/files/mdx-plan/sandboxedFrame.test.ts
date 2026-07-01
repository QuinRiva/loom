// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

// The authored demo plan, imported raw so the test drives the REAL render
// pipeline against the REAL file (Vite `?raw`).
import demoPlanSource from "../../../../../../plans/mdx-plan-annotation/plan.mdx?raw";

import { anchorForBlockElement, resolveAnchor } from "./annotation/anchoring";
import { assignBlockIds, compilePlanMdx } from "./MdxPlanRenderer";
import {
  HTML_CSP,
  HTML_SANDBOX,
  HtmlBlockRead,
  PROTOTYPE_CSP,
  PROTOTYPE_SANDBOX,
  PrototypeRead,
} from "./blocks/sandboxedFrame";
import { PLAN_BLOCKS, PLAN_BLOCK_COMPONENTS, parsePlanBlock, serializePlanBlock } from "./registry";

/**
 * The sandboxed-iframe surfaces (`<Prototype>` C4, `<HtmlBlock>` B5) are the
 * untrusted-content boundary: the iframe sandbox + `srcdoc` CSP is THE security
 * mechanism (D9). These lock in the exact `sandbox`/CSP invariants a security
 * review depends on — no `allow-same-origin` on the prototype, no `allow-scripts`
 * on HtmlBlock — plus whole-block annotatability and the MDX wire round-trip.
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

describe("HtmlBlock iframe — static, scripts fully disabled", () => {
  it("uses a fully-locked sandbox with NO allow-scripts (empty sandbox attr)", () => {
    const iframe = renderHtmlBlock().querySelector("iframe")!;
    const sandbox = iframe.getAttribute("sandbox");
    expect(sandbox).toBe(HTML_SANDBOX);
    expect(sandbox).toBe(""); // sandbox="" → maximally restricted, opaque origin, no JS
    expect(sandbox).not.toContain("allow-scripts");
  });

  it("carries a no-script CSP", () => {
    const srcdoc = renderHtmlBlock().querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(srcdoc).toContain(`content="${HTML_CSP}"`);
    expect(HTML_CSP).toContain("default-src 'none'");
    expect(HTML_CSP).not.toContain("script-src"); // no script directive at all
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
    expect(html).toContain('sandbox=""');
  });
});
