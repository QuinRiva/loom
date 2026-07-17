// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { DetailsRead } from "./details";
import { PlanEagerMountContext } from "../planEagerMount";

/**
 * `<Details>` lazy-mounting (B2): a collapsed disclosure does NOT mount its
 * children until first opened (halving initial DOM on evidence-heavy docs), then
 * keeps them mounted so re-opening is instant. The {@link PlanEagerMountContext}
 * escape hatch forces eager mounting — the annotation layer sets it when a
 * comment may be anchored inside a closed drill-down (so it resolves as
 * `collapsed`, not `detached`).
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
    // Reachable by switching threads in one workspace: FilePreviewPanel is keyed
    // by environment, so the same <Details> instance survives while the draft
    // target's comments (and thus the eager flag) change. A persisted comment
    // inside a never-opened disclosure for the newly-selected thread must not
    // degrade to `detached` — the children have to mount on the transition.
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
