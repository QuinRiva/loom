// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

// The authored demo plan, imported as a raw string (Vite `?raw`) so the test
// exercises the REAL render pipeline against the REAL file — no node fs/path.
import demoPlanSource from "../../../../../../plans/mdx-plan-annotation/plan.mdx?raw";

import { compilePlanMdx } from "./MdxPlanRenderer";
import { PLAN_BLOCK_COMPONENTS } from "./registry";

import {
  anchorForCanvasPoint,
  anchorForWireframeNode,
  resolveAnchor,
  resolveCanvasAnchor,
} from "./annotation/anchoring";
import { assignBlockIds } from "./MdxPlanRenderer";
import {
  ArtboardRead,
  CANVAS_BOARD_SCALE,
  DesignBoardRead,
  canvasTransformForElement,
  createCanvasTransform,
} from "./blocks/canvas";
import { DesignRead } from "./blocks/screen";
import { PLAN_BLOCKS, parsePlanBlock, serializePlanBlock } from "./registry";

/**
 * Wave C2/C3 coverage: the board\u2192pixel transform is the single geometry model
 * shared by authored artboard layout AND free-floating canvas review anchors
 * (A1's `resolveCanvasAnchor`), node-pin anchoring works on a positioned canvas
 * artboard exactly as for a standalone `<Screen>`, and the design-fidelity tier
 * preserves branded theme classes while STILL being sanitised (SMIL / on* / the
 * wireframe exploit shapes are stripped the same way).
 */

function parse(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

/** Render a DesignBoard wrapping children through React context (static). */
function renderBoard(...children: unknown[]): string {
  return renderToStaticMarkup(
    createElement(
      DesignBoardRead,
      { data: { title: "Flow" }, blockId: "board-1" },
      ...(children as never[]),
    ),
  );
}

describe("canvas — board\u2192pixel transform", () => {
  it("maps board units to pixels at the canonical ~2 units/px scale", () => {
    const t = createCanvasTransform();
    expect(t.boardScale).toBe(CANVAS_BOARD_SCALE);
    expect(t.boardToPixel({ x: 760, y: 200 })).toEqual({ x: 380, y: 100 });
  });

  it("rebuilds the transform from a rendered board's data-board-scale", () => {
    const board = parse(renderBoard()).querySelector('[data-plan-block-type="canvas"]')!;
    expect(board.getAttribute("data-board-scale")).toBe("0.5");
    const t = canvasTransformForElement(board);
    expect(t.boardToPixel({ x: 100, y: 50 })).toEqual({ x: 50, y: 25 });
  });
});

describe("canvas — layout", () => {
  it("positions an artboard at its board coordinate via the shared transform", () => {
    const artboard = createElement(ArtboardRead, {
      data: { x: 760, y: 100, surface: "mobile", html: "<h2>Verify</h2>" },
      blockId: "cv-verify",
    });
    const el = parse(renderBoard(artboard)).querySelector<HTMLElement>(".plan-canvas-artboard")!;
    // 760 * 0.5 = 380, 100 * 0.5 = 50
    expect(el.style.left).toBe("380px");
    expect(el.style.top).toBe("50px");
    // the inner ScreenRead figure carries the annotation contract, not the wrapper
    expect(el.querySelector('[data-plan-block-type="wireframe"]')).not.toBeNull();
    expect(el.querySelector("[data-plan-block-id]")?.getAttribute("data-plan-block-id")).toBe(
      "cv-verify",
    );
  });
});

describe("canvas — free-floating anchor via resolveCanvasAnchor", () => {
  it("resolves a board-space region anchor to a pixel box through this canvas transform", () => {
    const anchor = anchorForCanvasPoint({ x: 200, y: 100, width: 40, height: 20 });
    expect(anchor.anchorKind).toBe("canvas");
    expect(resolveCanvasAnchor(anchor, createCanvasTransform())).toEqual({
      x: 100,
      y: 50,
      width: 20,
      height: 10,
    });
  });

  it("gives a bare point anchor a fallback footprint", () => {
    expect(
      resolveCanvasAnchor(anchorForCanvasPoint({ x: 40, y: 60 }), createCanvasTransform()),
    ).toEqual({ x: 20, y: 30, width: 6, height: 6 });
  });
});

describe("canvas — node pin on a positioned artboard", () => {
  it("captures + resolves a node pin against an artboard rendered inside a DesignBoard", () => {
    const artboard = createElement(ArtboardRead, {
      data: {
        x: 400,
        y: 0,
        surface: "mobile",
        html: "<div><label>Email</label><button>Continue</button></div>",
      },
      blockId: undefined, // no authored id \u2014 assignBlockIds must fill it (S1 pattern)
    });
    document.body.innerHTML = `<div data-plan-root>${renderBoard(artboard)}</div>`;
    const root = document.querySelector<HTMLElement>("[data-plan-root]")!;
    assignBlockIds(root);

    const button = root.querySelector("button")!;
    expect(button.hasAttribute("data-wf-node")).toBe(true); // stamped by ScreenRead
    const pin = anchorForWireframeNode(button, root)!;
    expect(pin.anchor.anchorKind).toBe("wireframe");
    expect(pin.anchor.targetSelector).toContain("data-plan-block-id"); // assignBlockIds-filled
    expect(resolveAnchor(pin.anchor, root)?.toString()).toContain("Continue");
  });
});

describe("canvas / design — MDX attr round-trip (wire contract)", () => {
  const entryFor = (tag: string) => PLAN_BLOCKS.find((e) => e.tag === tag)!;
  const roundTrip = (tag: string, data: unknown) =>
    parsePlanBlock(entryFor(tag), serializePlanBlock(entryFor(tag), data));

  it("round-trips an Artboard (numeric board coords + optional fidelity)", () => {
    const data = { x: 760, y: 0, surface: "mobile", html: "<h2>Verify</h2>", caption: "Verify" };
    expect(roundTrip("Artboard", data)).toEqual(data);
  });

  it("round-trips a Connector and a DesignBoard", () => {
    expect(roundTrip("Connector", { from: "a", to: "b", label: "submit" })).toEqual({
      from: "a",
      to: "b",
      label: "submit",
    });
    expect(roundTrip("DesignBoard", { title: "Flow", width: 2400, height: 1040 })).toEqual({
      title: "Flow",
      width: 2400,
      height: 1040,
    });
  });
});

describe("canvas / design — real demo plan renders end-to-end", () => {
  it("compiles the authored plan.mdx (canvas + design blocks) through the MDX pipeline", async () => {
    const Content = await compilePlanMdx(demoPlanSource); // throws on unknown tag / guard rejection
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    expect(html).toContain('data-plan-block-type="canvas"'); // DesignBoard
    expect(html).toContain('data-plan-block-type="design"'); // Design tier
    expect(html).toContain("plan-canvas-artboard"); // positioned Artboards
    expect(html).not.toContain("<script"); // wireframe/design html sanitised
  });
});

describe("canvas / design tier — sanitised branded render", () => {
  const DIRTY =
    "<div class='wf-card bg-white shadow-xl' style='padding:8px'>Dashboard" +
    "<button onclick='pwn()'>x</button>" +
    "<img src=x onerror='pwn()' />" +
    "<svg><animate attributeName='href' to='javascript:pwn()'/></svg></div>";

  it("preserves theme classes for design fidelity while stripping exploit shapes", () => {
    const html = renderToStaticMarkup(
      createElement(DesignRead, { data: { surface: "browser", html: DIRTY }, blockId: "d1" }),
    );
    const el = parse(html);
    const artboard = el.querySelector('[data-plan-block-type="design"]')!;
    expect(artboard).not.toBeNull();
    expect(artboard.getAttribute("data-wf-fidelity")).toBe("design");
    expect(el.querySelector(".plan-design-surface")).not.toBeNull();

    // branded theme classes preserved (the wireframe tier would strip these)
    const card = el.querySelector(".wf-card")!;
    expect(card.className).toContain("bg-white");
    expect(card.className).toContain("shadow-xl");

    // still fully sanitised: no handlers, no SMIL, no script
    expect(html).not.toMatch(/onerror|onclick/i);
    expect(html.toLowerCase()).not.toContain("<animate");
    expect(html).not.toContain("<script");
    expect(html).toContain("Dashboard");
  });
});
