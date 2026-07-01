// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

// The authored demo plan, imported raw so the test drives the REAL render
// pipeline against the REAL file (Vite `?raw`).
import demoPlanSource from "../../../../../../plans/mdx-plan-annotation/plan.mdx?raw";

import {
  anchorForBlockElement,
  anchorFromRange,
  enclosingBlock,
  resolveAnchor,
} from "./annotation/anchoring";
import { assignBlockIds, compilePlanMdx } from "./MdxPlanRenderer";
import { ColumnRead, ColumnsRead } from "./blocks/columns";
import { TabRead, TabsRead } from "./blocks/tabs";
import { PLAN_BLOCKS, PLAN_BLOCK_COMPONENTS, parsePlanBlock, serializePlanBlock } from "./registry";

/**
 * Wave B6 — container blocks (`Columns`/`TabsBlock`). The load-bearing property is
 * that nesting must NOT break annotation: `assignBlockIds` recurses so every
 * nested block gets a distinct id, and a whole-block/text anchor on a nested
 * block resolves to *that block* — never the container, never the first match
 * (mirrors the A2 nested-anchor test, now against the real components). Also
 * covers the MDX attr round-trip (wire contract) and interactive tab switching.
 */

function parse(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

/** Render a `<Columns>` with two `<Column>`s, each holding a distinct code block. */
function renderColumns(): string {
  const codeBlock = (text: string) =>
    createElement("figure", { "data-plan-block-type": "code" }, createElement("span", null, text));
  return renderToStaticMarkup(
    createElement(
      ColumnsRead,
      { data: {}, blockId: undefined },
      createElement(
        ColumnRead,
        { data: { label: "Before" }, blockId: undefined },
        codeBlock("before code"),
      ),
      createElement(
        ColumnRead,
        { data: { label: "After" }, blockId: undefined },
        codeBlock("after code"),
      ),
    ),
  );
}

describe("containers — Columns nesting + annotation (A2)", () => {
  function setup(): HTMLElement {
    document.body.innerHTML = `<div data-plan-root><h2>Migration</h2>${renderColumns()}</div>`;
    const root = document.querySelector<HTMLElement>("[data-plan-root]")!;
    assignBlockIds(root);
    return root;
  }

  it("renders the container as one annotatable block with its label slots", () => {
    const el = parse(renderColumns());
    const container = el.querySelector('[data-plan-block-type="columns"]')!;
    expect(container).not.toBeNull();
    expect(el.querySelectorAll(".plan-column").length).toBe(2);
    expect(el.textContent).toContain("Before");
    expect(el.textContent).toContain("After");
  });

  it("assigns a distinct id to the container and every nested block", () => {
    const root = setup();
    const ids = Array.from(root.querySelectorAll("[data-plan-block-type]"), (b) =>
      b.getAttribute("data-plan-block-id"),
    );
    expect(ids.length).toBe(3); // Columns container + 2 nested code blocks
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // all distinct across nesting
  });

  it("enclosingBlock of a selection inside a nested block is the nested block, not the container", () => {
    const root = setup();
    const span = root.querySelectorAll('[data-plan-block-type="code"]')[1]!.querySelector("span")!;
    expect(enclosingBlock(span.firstChild!)?.type).toBe("code"); // nearest, NOT "columns"
  });

  it("a whole-block anchor on a nested block resolves to that block, not the container or first match", () => {
    const root = setup();
    const after = root.querySelectorAll('[data-plan-block-type="code"]')[1]!;
    const resolved = resolveAnchor(anchorForBlockElement(after, root).anchor, root);
    expect(resolved?.toString()).toContain("after code");
    expect(resolved?.toString()).not.toContain("before code");
  });

  it("a selection inside a nested block yields a visual anchor with the document-level section", () => {
    const root = setup();
    const text = root
      .querySelectorAll('[data-plan-block-type="code"]')[1]!
      .querySelector("span")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const res = anchorFromRange(range, root);
    expect(res?.anchor.anchorKind).toBe("visual");
    expect(res?.anchor.sectionTitle).toBe("Migration"); // document heading, not nesting-local
    expect(resolveAnchor(res!.anchor, root)?.toString()).toContain("after code");
  });
});

describe("containers — Tabs nesting keeps every panel's blocks stamped", () => {
  it("stamps nested blocks in ALL panels (inactive panels stay mounted, hidden)", () => {
    const panel = (text: string) =>
      createElement(
        "figure",
        { "data-plan-block-type": "code" },
        createElement("span", null, text),
      );
    const html = renderToStaticMarkup(
      createElement(
        TabsRead,
        { data: {}, blockId: undefined },
        createElement(TabRead, { data: { label: "One" }, blockId: undefined }, panel("panel one")),
        createElement(TabRead, { data: { label: "Two" }, blockId: undefined }, panel("panel two")),
      ),
    );
    document.body.innerHTML = `<div data-plan-root>${html}</div>`;
    const root = document.querySelector<HTMLElement>("[data-plan-root]")!;
    assignBlockIds(root);

    // Both panels are in the DOM; the 2nd is hidden but its block is still stamped.
    const panels = root.querySelectorAll('[role="tabpanel"]');
    expect(panels.length).toBe(2);
    expect(panels[1]!.hasAttribute("hidden")).toBe(true);
    const codeIds = Array.from(root.querySelectorAll('[data-plan-block-type="code"]'), (b) =>
      b.getAttribute("data-plan-block-id"),
    );
    expect(codeIds.length).toBe(2);
    expect(new Set(codeIds).size).toBe(2); // both distinct — the hidden one too

    // A whole-block anchor on the hidden panel's block still resolves to it.
    const hidden = root.querySelectorAll('[data-plan-block-type="code"]')[1]!;
    const resolved = resolveAnchor(anchorForBlockElement(hidden, root).anchor, root);
    expect(resolved?.toString()).toContain("panel two");
  });
});

describe("containers — interactive tab switching (keyboard + click)", () => {
  it("switches the active panel on click and arrow keys, updating aria-selected + hidden", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const panel = (text: string) => createElement("p", null, text);
    const tree = createElement(
      TabsRead,
      { data: {}, blockId: "tabs-1" },
      createElement(TabRead, { data: { label: "One" }, blockId: undefined }, panel("panel one")),
      createElement(TabRead, { data: { label: "Two" }, blockId: undefined }, panel("panel two")),
      createElement(
        TabRead,
        { data: { label: "Three" }, blockId: undefined },
        panel("panel three"),
      ),
    );
    const root = createRoot(container);
    await act(async () => {
      root.render(tree);
    });

    const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const panels = () => Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]'));

    // Initially the first tab is active.
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(panels()[0]!.hasAttribute("hidden")).toBe(false);
    expect(panels()[1]!.hasAttribute("hidden")).toBe(true);
    // aria wiring: tab controls its panel; panel is labelled by its tab.
    expect(tabs()[1]!.getAttribute("aria-controls")).toBe(panels()[1]!.id);
    expect(panels()[1]!.getAttribute("aria-labelledby")).toBe(tabs()[1]!.id);

    // Click the third tab → it becomes active, others hidden.
    await act(async () => {
      tabs()[2]!.click();
    });
    expect(tabs()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(panels()[2]!.hasAttribute("hidden")).toBe(false);
    expect(panels()[0]!.hasAttribute("hidden")).toBe(true);

    // ArrowRight wraps from the last tab back to the first.
    await act(async () => {
      tabs()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");

    // Roving tabindex: only the active tab is in the tab order.
    expect(tabs()[0]!.tabIndex).toBe(0);
    expect(tabs()[1]!.tabIndex).toBe(-1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("containers — MDX attr round-trip (wire contract)", () => {
  const entryFor = (tag: string) => PLAN_BLOCKS.find((e) => e.tag === tag)!;
  const roundTrip = (tag: string, data: unknown) =>
    parsePlanBlock(entryFor(tag), serializePlanBlock(entryFor(tag), data));

  it("round-trips Columns/Column and TabsBlock/Tab attributes", () => {
    expect(roundTrip("Columns", {})).toEqual({});
    expect(roundTrip("Column", { label: "Before" })).toEqual({ label: "Before" });
    expect(roundTrip("TabsBlock", { orientation: "vertical" })).toEqual({
      orientation: "vertical",
    });
    expect(roundTrip("Tab", { label: "Overview" })).toEqual({ label: "Overview" });
  });
});

describe("containers — real demo plan renders end-to-end", () => {
  it("compiles the authored plan.mdx (Columns + TabsBlock) through the MDX pipeline", async () => {
    const Content = await compilePlanMdx(demoPlanSource); // throws on unknown tag / guard reject
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    expect(html).toContain('data-plan-block-type="columns"');
    expect(html).toContain('data-plan-block-type="tabs"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("plan-column");
  });
});
