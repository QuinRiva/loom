// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { flattenDocument } from "../components/files/mdx-plan/annotation/anchoring";
import {
  compilePlanDocument,
  compilePlanMdx,
} from "../components/files/mdx-plan/mdxCompileOptions";
import { MdxPlanRenderer } from "../components/files/mdx-plan/MdxPlanRenderer";
import { lintPlanSource } from "../components/files/mdx-plan/planLint";
import { MDX_QUESTION_REFS_FIXTURE_SOURCE } from "./fixtures";

/**
 * loom — the "peek at the referenced section" feature, driven against the REAL
 * renderer. It earns a test because its risk is invisible to a static read: the
 * peek is a SECOND live render of a section that is also in the document, and a
 * second render that leaked text or block ids into the annotation layer would
 * silently move existing comment highlights. The other half is that the render
 * is genuinely live (a clone would be inert), which only a click can prove.
 */

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
};

const renderPlan = async (source: string) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MdxPlanRenderer, { source }));
  });
  await settle();
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
  const click = async (label: string) => {
    await act(async () => button(label).click());
    await settle();
  };
  return {
    button,
    click,
    planRoot: container.querySelector("[data-plan-root]") as HTMLElement,
    peek: () => document.querySelector<HTMLElement>("[data-plan-peek]"),
    blockIds: () =>
      [...container.querySelectorAll("[data-plan-block-id]")].map((el) =>
        el.getAttribute("data-plan-block-id"),
      ),
    dispose: () => {
      root.unmount();
      container.remove();
    },
  };
};

/** A section whose body is interactive (`TabsBlock` panels are React state) and a
 * section carrying an authored block id — the two cases a DOM clone got wrong. */
const PEEK_SOURCE = [
  "# Peek",
  "",
  "## Interactive section",
  "",
  "<TabsBlock>",
  "",
  '<Tab label="First">',
  "",
  "First panel prose.",
  "",
  "</Tab>",
  "",
  '<Tab label="Second">',
  "",
  "Second panel prose.",
  "",
  "</Tab>",
  "",
  "</TabsBlock>",
  "",
  "## Schema",
  "",
  '<Table id="schema-table" columns={["Column", "Type"]} rows={[["plan_lane", "text"]]} />',
  "",
  "## Open questions",
  "",
  `<QuestionForm questions={${JSON.stringify([
    {
      id: "q",
      title: "Does the peek render live?",
      mode: "single",
      refs: [
        { label: "Interactive", anchor: "interactive-section" },
        { label: "Schema", anchor: "schema" },
      ],
      options: [{ id: "yes", label: "Yes" }],
    },
  ])}} />`,
].join("\n");

describe("question ref peek", () => {
  it("slices a section from its heading to the next same-or-higher heading", async () => {
    const { sections } = await compilePlanDocument(MDX_QUESTION_REFS_FIXTURE_SOURCE);
    const slice = MDX_QUESTION_REFS_FIXTURE_SOURCE.slice(...sections["delivery-order"]!);
    expect(slice).toContain("### Slice 2"); // sub-sections come along
    expect(slice).not.toContain("## Rollout and flags");
    expect(sections["no-such-section"]).toBeUndefined();
  });

  /**
   * The gate's whole claim is "lint says OK => the chip opens that section". It
   * holds only because lint, the renderer and the peek read section bounds off
   * the SAME mdast: a text-level scanner saw phantom headings inside nested
   * fences and template literals, and cut slices through JSX. Each source below
   * broke that scanner; every anchor lint accepts must slice to something that
   * compiles.
   */
  const GNARLY: Record<string, string> = {
    "heading nested in a container": [
      "# Doc",
      "",
      "<Columns>",
      "",
      "<Column>",
      "",
      "## Nested heading",
      "",
      "Body inside a column.",
      "",
      "</Column>",
      "",
      "</Columns>",
      "",
      "## After",
      "",
      "Tail.",
    ].join("\n"),
    "markdown sample inside a nested fence": [
      "# Doc",
      "",
      "## Alpha",
      "",
      "Real alpha body.",
      "",
      "````md",
      "```mdx",
      "## Phantom heading",
      "```",
      "````",
      "",
      "End of alpha.",
      "",
      "## Beta",
      "",
      "Beta body.",
    ].join("\n"),
    "hash comment inside a template-literal attribute": [
      "# Doc",
      "",
      "## Install",
      "",
      '<Code language="sh" code={`# install first',
      "npm i`} />",
      "",
      "## Next",
      "",
      "Next body.",
    ].join("\n"),
    "setext heading and a heading containing a link": [
      "# Doc",
      "",
      "Setext title",
      "============",
      "",
      "Body.",
      "",
      "## See [the RFC](https://example.com) first",
      "",
      "Linked body.",
    ].join("\n"),
  };

  it("gives every anchor lint accepts a slice that compiles", async () => {
    for (const [name, source] of Object.entries(GNARLY)) {
      const { sections } = await compilePlanDocument(source);
      expect(Object.keys(sections).length, name).toBeGreaterThan(1);
      for (const [slug, bounds] of Object.entries(sections)) {
        await expect(
          compilePlanMdx(source.slice(...bounds)),
          `${name} / ${slug}`,
        ).resolves.toBeTruthy();
      }
      expect(await lintPlanSource(source), name).toEqual([]);
    }

    const nested = await compilePlanDocument(GNARLY["heading nested in a container"]!);
    // Bounded by its siblings, so the slice never cuts through the container.
    expect(
      GNARLY["heading nested in a container"]!.slice(...nested.sections["nested-heading"]!).trim(),
    ).toBe("Body inside a column.");

    const fenced = await compilePlanDocument(GNARLY["markdown sample inside a nested fence"]!);
    expect(fenced.sections["phantom-heading"]).toBeUndefined();
    // Not truncated at the phantom heading: the whole sample and the prose after
    // it belong to the section.
    expect(
      GNARLY["markdown sample inside a nested fence"]!.slice(...fenced.sections["alpha"]!),
    ).toContain("End of alpha.");

    const linked = await compilePlanDocument(
      GNARLY["setext heading and a heading containing a link"]!,
    );
    expect(Object.keys(linked.sections)).toContain("see-the-rfc-first");
    expect(Object.keys(linked.sections)).toContain("setext-title");
  });

  it("lints clean (every ref anchor resolves to a heading)", async () => {
    expect(await lintPlanSource(MDX_QUESTION_REFS_FIXTURE_SOURCE)).toEqual([]);
  });

  it("reveals the section without disturbing document anchoring", async () => {
    const { click, peek, planRoot, blockIds, dispose } = await renderPlan(
      MDX_QUESTION_REFS_FIXTURE_SOURCE,
    );

    expect(planRoot.querySelector("#delivery-order")?.tagName).toBe("H2");
    expect(planRoot.querySelector("#slice-2-backfill")?.tagName).toBe("H3");
    const text = flattenDocument(planRoot).text;
    const ids = blockIds();

    await click("Delivery order");
    const open = peek()!;
    expect(open.textContent).toContain("Three slices, each shippable");
    expect(open.textContent).toContain("Slice 2"); // sub-headings come along

    // The peek renders OUTSIDE the plan root (portalled to <body>), which is what
    // every annotation query and block-id lookup is scoped to, and it consumes no
    // assigned block id. So the document's flattened text and its ids are
    // untouched while a peek is open.
    expect(open.contains(planRoot)).toBe(false);
    expect(planRoot.contains(open)).toBe(false);
    expect(open.querySelector("[data-plan-block-id^='plan-block-']")).toBeNull();
    // A section compiles without heading ids, so a peeked sub-heading cannot
    // duplicate the id the document already carries.
    expect(planRoot.querySelectorAll("#slice-2-backfill").length).toBe(1);
    expect([...open.querySelectorAll("h1,h2,h3,h4,h5,h6")].some((h) => h.id)).toBe(false);
    expect(flattenDocument(planRoot).text).toBe(text);
    expect(blockIds()).toEqual(ids);

    await click("Delivery order"); // the same chip closes it
    expect(peek()).toBeNull();
    dispose();
  });

  it("renders the section live: nested blocks are interactive and authored ids stay resolvable", async () => {
    const { button, click, peek, planRoot, dispose } = await renderPlan(PEEK_SOURCE);

    await click("Interactive");
    const tabs = peek()!.querySelectorAll<HTMLElement>("[role='tab']");
    expect([...tabs].map((tab) => tab.textContent)).toEqual(["First", "Second"]);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    // A cloned section would be inert here; a live render switches panels.
    await act(async () => tabs[1]!.click());
    expect(peek()!.querySelectorAll("[role='tab']")[1]?.getAttribute("aria-selected")).toBe("true");

    // Scrolling INSIDE the peek is reading, not dismissal; scrolling the
    // document behind it closes (fixed coordinates cannot follow a panel).
    await act(async () => {
      peek()!.lastElementChild!.dispatchEvent(new Event("scroll"));
    });
    expect(peek()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(peek()).toBeNull();

    await click("Schema");
    expect(peek()!.querySelector("[data-plan-block-type='table']")).toBeTruthy();
    // The peeked copy of an authored id cannot hijack the document's anchor:
    // the annotation layer resolves block ids inside the plan root only.
    expect(planRoot.querySelectorAll("[data-plan-block-id='schema-table']").length).toBe(1);

    // Escape closes and hands focus back to the chip that opened it.
    expect(peek()!.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(peek()).toBeNull();
    expect(document.activeElement).toBe(button("Schema"));
    dispose();
  });
});
