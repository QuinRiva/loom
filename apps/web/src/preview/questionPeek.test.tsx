// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { flattenDocument } from "../components/files/mdx-plan/annotation/anchoring";
import {
  PlanPeekVariantContext,
  type PlanPeekVariant,
} from "../components/files/mdx-plan/blocks/questionRefs";
import { MdxPlanRenderer } from "../components/files/mdx-plan/MdxPlanRenderer";
import { lintPlanSource } from "../components/files/mdx-plan/planLint";
import { MDX_QUESTION_REFS_FIXTURE_SOURCE } from "./fixtures";

/**
 * loom, PROTOTYPE — the "peek at the referenced section" behaviour, driven against
 * the REAL renderer and the preview fixture. It earns a test because its one
 * genuine risk is invisible to a static read: the peek reveals a DOM *clone* of a
 * section that is still in the document, and a clone that leaked ids or text into
 * the annotation layer's flattened document would silently move existing comment
 * highlights. Delete this with the prototype if it is dropped.
 */

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
};

const renderPlan = async (variant: PlanPeekVariant) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        PlanPeekVariantContext.Provider,
        { value: variant },
        createElement(MdxPlanRenderer, { source: MDX_QUESTION_REFS_FIXTURE_SOURCE }),
      ),
    );
  });
  await settle();
  const chip = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
  return {
    container,
    planRoot: container.querySelector("[data-plan-root]")!,
    chip,
    dispose: () => {
      root.unmount();
      container.remove();
    },
  };
};

describe("question ref peek", () => {
  it("lints clean (every ref anchor resolves to a heading)", async () => {
    expect(await lintPlanSource(MDX_QUESTION_REFS_FIXTURE_SOURCE)).toEqual([]);
  });

  it("reveals the referenced section inline without disturbing document anchoring", async () => {
    const { planRoot, chip, dispose } = await renderPlan("inline");

    expect(planRoot.querySelector("#delivery-order")?.tagName).toBe("H2");
    expect(planRoot.querySelector("#slice-2-backfill")?.tagName).toBe("H3");
    const before = flattenDocument(planRoot).text;

    await act(async () => chip("Delivery order").click());
    await settle();

    const peek = planRoot.querySelector("[data-plan-peek]")!;
    expect(peek.textContent).toContain("Three slices, each shippable");
    expect(peek.textContent).toContain("Slice 2"); // sub-headings come along
    expect(peek.querySelectorAll("[data-plan-block-id], [id]").length).toBe(0);
    // The clone is invisible to anchoring: the flattened document is unchanged.
    expect(flattenDocument(planRoot).text).toBe(before);

    await act(async () => chip("Delivery order").click());
    expect(planRoot.querySelector("[data-plan-peek]")).toBeNull();

    // A ref onto a section whose body is a block clones the block.
    await act(async () => chip("Schema").click());
    await settle();
    expect(
      planRoot.querySelector("[data-plan-peek]")!.querySelector("[data-plan-block-type='table']"),
    ).toBeTruthy();

    await act(async () => chip("Schema").click());
    expect(planRoot.querySelector("[data-plan-peek]")).toBeNull();
    dispose();
  });

  it("opens the popover variant outside the clipped form, and Escape closes it", async () => {
    const { chip, dispose } = await renderPlan("popover");

    await act(async () => chip("Rollout and flags").click());
    await settle();
    const peek = document.querySelector("[data-plan-peek]")!;
    expect(peek.parentElement).toBe(document.body); // portalled past `overflow-hidden`
    expect(peek.textContent).toContain("house style");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector("[data-plan-peek]")).toBeNull();
    dispose();
  });
});
