// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TableRead, tableMdx } from "./table";

/**
 * The `<Table filterable>` affordance (C1): the plain table is unchanged, and
 * the opt-in `filterable` prop adds a case-insensitive substring filter across
 * all cells (with a filtered/total count) plus header-click sort that cycles
 * asc → desc → unsorted with a numeric-aware comparison. The `filterable`
 * attribute round-trips only when true.
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
