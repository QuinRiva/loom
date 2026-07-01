// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { assignBlockIds } from "../MdxPlanRenderer";
import { anchorForBlockElement, anchorFromRange, resolveAnchor } from "./anchoring";

/**
 * Anchoring is the highest-risk logic in the MDX-plan vertical: it serialises a
 * live DOM `Range` into a portable anchor and re-resolves it after a re-render
 * (or to `null` when the quoted text is gone). A silent bug here mis-attaches a
 * reviewer's comment to the wrong passage. This exercises the text-quote
 * round-trip, heading-derived sections, context disambiguation of duplicate
 * quotes, the whole-block (`visual`) fallback for non-prose blocks, the
 * per-block affordance anchor, and detached resolution — ported from the spike
 * validation harness onto a real jsdom DOM.
 */

const HTML = `<div data-plan-root>
  <h2 data-plan-block-id="sec-a">Overview</h2>
  <p data-plan-block-id="p1">The system uses a shared cache to reduce load.</p>
  <h2 data-plan-block-id="sec-b">Details</h2>
  <p data-plan-block-id="p2">Then the system uses a shared cache again here.</p>
  <figure data-plan-block-id="dia1" data-plan-block-type="diagram"><span>Node A</span><span>Node B</span></figure>
</div>`;

let root: Element;

beforeEach(() => {
  document.body.innerHTML = HTML;
  root = document.querySelector("[data-plan-root]")!;
});

/** Build a `Range` over the `nth` (0-based) occurrence of `needle` in the tree. */
function rangeForText(needle: string, nth = 0): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode();
  while (node) {
    const idx = (node as Text).data.indexOf(needle);
    if (idx !== -1 && seen++ === nth) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      return range;
    }
    node = walker.nextNode();
  }
  throw new Error(`needle not found: ${needle}`);
}

describe("anchoring — text-quote round-trip", () => {
  it("serialises a prose selection to a text anchor and resolves it back", () => {
    const res = anchorFromRange(rangeForText("shared cache"), root);
    expect(res?.anchor.anchorKind).toBe("text");
    expect(res?.anchor.sectionTitle).toBe("Overview"); // nearest preceding heading
    expect(res?.quotedText).toBe("shared cache");
    expect(resolveAnchor(res!.anchor, root)?.toString()).toBe("shared cache");
  });
});

describe("anchoring — context disambiguation", () => {
  it("resolves the 2nd occurrence of a duplicate quote via context", () => {
    const res = anchorFromRange(rangeForText("shared cache", 1), root);
    expect(res?.anchor.sectionTitle).toBe("Details");
    const back = resolveAnchor(res!.anchor, root);
    const container = back?.startContainer.parentElement?.closest("[data-plan-block-id]");
    expect(container?.getAttribute("data-plan-block-id")).toBe("p2");
  });
});

describe("anchoring — whole-block fallback", () => {
  it("falls back to a visual (whole-block) anchor inside a non-prose block", () => {
    const res = anchorFromRange(rangeForText("Node A"), root);
    expect(res?.anchor.anchorKind).toBe("visual");
    expect(res?.anchor.targetSelector).toBe('[data-plan-block-id="dia1"]');
    expect(res?.anchor.targetKind).toBe("diagram");
    expect(resolveAnchor(res!.anchor, root)?.startContainer).toBeDefined();
  });
});

describe("anchoring — per-block affordance", () => {
  it("serialises a whole block element to a resolvable visual anchor", () => {
    const el = root.querySelector('[data-plan-block-id="dia1"]')!;
    const res = anchorForBlockElement(el, root);
    expect(res.anchor.anchorKind).toBe("visual");
    expect(resolveAnchor(res.anchor, root)).not.toBeNull();
  });
});

describe("anchoring — un-id'd blocks get distinct anchors (S1)", () => {
  it("assigns distinct ids so whole-block anchors resolve to the right block", () => {
    // Two custom blocks with NO authored id (post-fix registry emits no attr).
    document.body.innerHTML = `<div data-plan-root>
      <figure data-plan-block-type="code"><span>first block</span></figure>
      <figure data-plan-block-type="code"><span>second block</span></figure>
    </div>`;
    const planRoot = document.querySelector<HTMLElement>("[data-plan-root]")!;
    assignBlockIds(planRoot);

    const blocks = planRoot.querySelectorAll("[data-plan-block-type]");
    const ids = Array.from(blocks, (b) => b.getAttribute("data-plan-block-id"));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]); // distinct — no empty-attr collision

    const second = anchorForBlockElement(blocks[1]!, planRoot);
    const resolved = resolveAnchor(second.anchor, planRoot);
    expect(resolved?.toString()).toContain("second block");
    expect(resolved?.toString()).not.toContain("first block");
  });
});

describe("anchoring — malformed id never throws (S2)", () => {
  it("treats a block id with selector metacharacters as detached, not a crash", () => {
    document.body.innerHTML = `<div data-plan-root><figure data-plan-block-type="code"><span>x</span></figure></div>`;
    const planRoot = document.querySelector("[data-plan-root]")!;
    const el = planRoot.querySelector("[data-plan-block-type]")!;
    el.setAttribute("data-plan-block-id", 'weird"]id');
    const res = anchorForBlockElement(el, planRoot);
    // CSS.escape keeps the selector valid, so it resolves rather than throwing.
    expect(() => resolveAnchor(res.anchor, planRoot)).not.toThrow();
    expect(resolveAnchor(res.anchor, planRoot)).not.toBeNull();
  });
});

describe("anchoring — detached resolution", () => {
  it("returns null when the quoted text no longer exists", () => {
    const res = anchorFromRange(rangeForText("shared cache"), root);
    document.body.innerHTML = `<div data-plan-root><p>totally different</p></div>`;
    const otherRoot = document.querySelector("[data-plan-root]")!;
    expect(resolveAnchor(res!.anchor, otherRoot)).toBeNull();
  });
});
