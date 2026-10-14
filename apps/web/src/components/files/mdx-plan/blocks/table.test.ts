// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { cellText, TableRead, tableBlock, tableMdx, type TableData } from "./table";

/**
 * The `<Table filterable>` affordance (C1): the plain table is unchanged, and
 * the opt-in `filterable` prop adds a case-insensitive substring filter across
 * all cells (with a filtered/total count) plus header-click sort that cycles
 * asc → desc → unsorted with a numeric-aware comparison. The `filterable`
 * attribute round-trips only when true.
 *
 * Vocabulary v2: a cell is inline markdown or `{ md, badge, tone }`, a row is
 * cells or `{ tone, cells }`, `align` sets per-column alignment, and filter/sort
 * read `cellText` (badge label + markdown source).
 */

const COLUMNS = ["Item", "Score"];
const ROWS = [
  ["banana", "10"],
  ["apple", "2"],
  ["cherry", "30"],
];

function mount(filterable: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root, filterable };
}

describe("Table filterable round-trip", () => {
  it("emits the attribute only when set", () => {
    expect(tableMdx.toAttrs({ columns: [], rows: [], filterable: true }).filterable).toBe(true);
    expect(tableMdx.toAttrs({ columns: [], rows: [] }).filterable).toBeUndefined();
    expect(
      tableMdx.toAttrs({ columns: [], rows: [], filterable: false }).filterable,
    ).toBeUndefined();
  });
});

describe("Table static (non-filterable) render", () => {
  it("renders no filter input or header buttons", () => {
    const html = renderToStaticMarkup(
      createElement(TableRead, { data: { columns: COLUMNS, rows: ROWS }, blockId: undefined }),
    );
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).toContain("banana");
  });
});

describe("Table filterable interaction", () => {
  it("filters rows case-insensitively and shows a filtered/total count", async () => {
    const { container, root } = mount(true);
    await act(async () => {
      root.render(
        createElement(TableRead, {
          data: { columns: COLUMNS, rows: ROWS, filterable: true },
          blockId: undefined,
        }),
      );
    });

    const count = () => container.querySelector("span.tabular-nums")?.textContent;
    expect(count()).toBe("3 of 3");

    const input = container.querySelector("input")!;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(input, "AN"); // uppercase → still matches "banana"
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const bodyText = container.querySelector("tbody")!.textContent ?? "";
    expect(bodyText).toContain("banana");
    expect(bodyText).not.toContain("apple");
    expect(count()).toBe("1 of 3");

    await act(async () => root.unmount());
    container.remove();
  });

  it("sorts by a clicked header, numeric-aware, cycling asc → desc → unsorted", async () => {
    const { container, root } = mount(true);
    await act(async () => {
      root.render(
        createElement(TableRead, {
          data: { columns: COLUMNS, rows: ROWS, filterable: true },
          blockId: undefined,
        }),
      );
    });

    const firstCell = () => container.querySelector("tbody tr td")?.textContent ?? "";
    const scoreHeader = Array.from(
      container.querySelectorAll<HTMLButtonElement>("thead button"),
    ).find((b) => b.textContent?.startsWith("Score"))!;

    // asc: numeric 2 < 10 < 30 → apple first (not lexicographic "10" < "2").
    await act(async () => scoreHeader.click());
    expect(firstCell()).toBe("apple");

    // desc: 30 first → cherry.
    await act(async () => scoreHeader.click());
    expect(firstCell()).toBe("cherry");

    // third click clears the sort → original document order (banana first).
    await act(async () => scoreHeader.click());
    expect(firstCell()).toBe("banana");

    await act(async () => root.unmount());
    container.remove();
  });
});

const render = (data: TableData) =>
  renderToStaticMarkup(createElement(TableRead, { data, blockId: undefined }));

describe("Table v2 cells and rows", () => {
  it("renders inline markdown in a string cell", () => {
    const html = render({ columns: ["A"], rows: [["**bold** and `code`"]] });
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).not.toContain("**");
  });

  it("renders a badge cell: pill before the text, bare label takes the cell tone, nowrap", () => {
    const html = render({
      columns: ["Today"],
      rows: [[{ badge: "lost", md: "no *decision*", tone: "risk" }]],
    });
    expect(html).toMatch(
      /<td class="[^"]*whitespace-nowrap[^"]*" style="background:var\(--plan-tone-risk-soft\)"><span class="plan-badge plan-badge--risk">lost<\/span> <span class="plan-inline-md">no <em>decision<\/em>/,
    );
  });

  it("tints a toned row and leaves plain rows untouched", () => {
    const html = render({
      columns: ["A"],
      rows: [{ tone: "success", cells: ["kept"] }, ["plain"]],
    });
    expect(html).toContain('style="background:var(--plan-tone-success-soft)"');
    expect(html.match(/plan-tone-/g)).toHaveLength(1);
  });

  it("aligns header and cells per column; omitted columns carry no style", () => {
    const html = render({ columns: ["Name", "Count"], rows: [["a", "3"]], align: ["left"] });
    expect(html.match(/text-align:left/g)).toHaveLength(2);
    expect(html).not.toContain("text-align:right");
    const right = render({
      columns: ["Name", "Count"],
      rows: [["a", "3"]],
      align: ["left", "right"],
    });
    expect(right.match(/text-align:right/g)).toHaveLength(2);
  });

  it("validates both row and cell shapes and rejects an unknown tone", () => {
    const ok = tableBlock.schema.safeParse({
      columns: ["A", "B"],
      rows: [
        ["x", { badge: { label: "y", tone: "info" } }],
        { tone: "risk", cells: ["z", { md: "w" }] },
      ],
      align: ["left", "right"],
    });
    expect(ok.success).toBe(true);
    expect(
      tableBlock.schema.safeParse({ columns: ["A"], rows: [{ tone: "red", cells: ["x"] }] })
        .success,
    ).toBe(false);
  });

  it("cellText joins the badge label and the markdown source", () => {
    expect(cellText("plain")).toBe("plain");
    expect(cellText({ badge: { label: "in place", tone: "success" }, md: "ported" })).toBe(
      "in place ported",
    );
    expect(cellText({ badge: "moot" })).toBe("moot");
  });

  it("filters over cellText, so a badge label matches its row", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(TableRead, {
          data: {
            columns: ["Fix", "Today"],
            rows: [
              ["Draw the edge", { badge: "moot", md: "deleted" }],
              {
                tone: "risk",
                cells: ["Clear the flag", { badge: { label: "lost", tone: "risk" } }],
              },
            ],
            filterable: true,
          },
          blockId: undefined,
        }),
      );
    });
    const input = container.querySelector("input")!;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(input, "LOST");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const bodyText = container.querySelector("tbody")!.textContent ?? "";
    expect(bodyText).toContain("Clear the flag");
    expect(bodyText).not.toContain("Draw the edge");

    await act(async () => root.unmount());
    container.remove();
  });
});
