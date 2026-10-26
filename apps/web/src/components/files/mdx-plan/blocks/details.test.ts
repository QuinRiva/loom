// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { DetailsRead } from "./details";
import { PlanEagerMountContext } from "../planEagerMount";

/**
 * `<Details>` mounts children on first open and keeps them mounted;
 * {@link PlanEagerMountContext} forces eager mounting so a comment inside a closed
 * drill-down resolves as `collapsed`, not `detached`.
 */

const DRILL = "DRILL_CONTENT";

function child() {
  return createElement("div", { "data-testid": "drill" }, DRILL);
}

function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root, node };
}

/** Render `<DetailsRead>` under an eager-mount context of `eager`. Returns a
 * `rerender(eager)` so a test can flip the context on the SAME instance. */
async function renderDetails(opts: { open?: boolean; eager?: boolean }) {
  // `open` is an exact-optional prop: only include it when defined.
  const data =
    opts.open === undefined ? { summary: "Evidence" } : { summary: "Evidence", open: opts.open };
  const tree = (eager: boolean) =>
    createElement(
      PlanEagerMountContext.Provider,
      { value: eager },
      createElement(DetailsRead, { data, blockId: undefined }, child()),
    );
  const { container, root } = mount(tree(opts.eager ?? false));
  const rerender = async (eager: boolean) => {
    await act(async () => {
      root.render(tree(eager));
    });
  };
  await rerender(opts.eager ?? false);
  return { container, root, rerender };
}

describe("Details lazy mount", () => {
  it("does not mount children while collapsed", async () => {
    const { container, root } = await renderDetails({});
    expect(container.textContent).not.toContain(DRILL);
    await act(async () => root.unmount());
    container.remove();
  });

  it("mounts children on first open and keeps them mounted after collapse", async () => {
    const { container, root } = await renderDetails({});
    const details = container.querySelector("details")!;

    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: false }));
    });
    expect(container.textContent).toContain(DRILL);

    // Collapsing keeps the children mounted (opened-once flag).
    await act(async () => {
      details.open = false;
      details.dispatchEvent(new Event("toggle", { bubbles: false }));
    });
    expect(container.querySelector('[data-testid="drill"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("mounts children immediately when authored open", async () => {
    const { container, root } = await renderDetails({ open: true });
    expect(container.textContent).toContain(DRILL);
    await act(async () => root.unmount());
    container.remove();
  });

  it("mounts children immediately under the eager-mount context", async () => {
    const { container, root } = await renderDetails({ eager: true });
    expect(container.textContent).toContain(DRILL);
    await act(async () => root.unmount());
    container.remove();
  });

  it("mounts (and retains) children when the eager context flips false → true", async () => {
    // FilePreviewPanel is keyed by environment, so a thread switch keeps this <Details>
    // instance while the eager flag flips; children must mount on the transition.
    const { container, root, rerender } = await renderDetails({ eager: false });
    expect(container.textContent).not.toContain(DRILL); // lazy while eager=false

    await rerender(true);
    expect(container.textContent).toContain(DRILL); // eager true → children mount

    // Retained even if the flag flips back to false (comments cleared).
    await rerender(false);
    expect(container.querySelector('[data-testid="drill"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });
});
