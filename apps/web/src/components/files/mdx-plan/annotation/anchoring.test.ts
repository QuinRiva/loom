// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { assignBlockIds } from "../MdxPlanRenderer";
import {
  type CanvasTransform,
  anchorForBlockElement,
  anchorForCanvasPoint,
  anchorForWireframeNode,
  anchorFromRange,
  enclosingBlock,
  resolveAnchor,
  resolveCanvasAnchor,
} from "./anchoring";

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

/**
 * Wave A2 — container blocks (`Columns`/`Tabs`) nest child blocks. Their renderers
 * don't exist yet (Wave B6), so this uses a throwaway stub whose shape mirrors
 * them: a `data-plan-block-type` container element whose children are themselves
 * plan blocks. It proves id assignment recurses (every nested block gets a
 * distinct id) and that whole-block/section resolution keys on the *nested* block
 * — not the container and not the first matching block.
 */
describe("anchoring — nested blocks in container blocks (A2)", () => {
  const NESTED_HTML = `<div data-plan-root>
    <h2>Before / After</h2>
    <div data-plan-block-type="columns">
      <figure data-plan-block-type="code"><span>before code</span></figure>
      <figure data-plan-block-type="code"><span>after code</span></figure>
    </div>
    <figure data-plan-block-type="diagram"><span>top diagram</span></figure>
  </div>`;

  function setup(): HTMLElement {
    document.body.innerHTML = NESTED_HTML;
    const nestedRoot = document.querySelector<HTMLElement>("[data-plan-root]")!;
    assignBlockIds(nestedRoot);
    return nestedRoot;
  }

  it("assigns a distinct id to every block at every nesting depth", () => {
    const nestedRoot = setup();
    const ids = Array.from(nestedRoot.querySelectorAll("[data-plan-block-type]"), (b) =>
      b.getAttribute("data-plan-block-id"),
    );
    expect(ids.length).toBe(4); // container + 2 nested code + 1 top diagram
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // all distinct across nesting
  });

  it("enclosingBlock of a selection inside a nested block is the nested block, not the container", () => {
    const nestedRoot = setup();
    const span = nestedRoot
      .querySelectorAll('[data-plan-block-type="code"]')[0]!
      .querySelector("span")!;
    const block = enclosingBlock(span.firstChild!);
    expect(block?.type).toBe("code"); // nearest ancestor, NOT "columns"
  });

  it("a whole-block anchor on a nested block resolves to that block, not the container or first match", () => {
    const nestedRoot = setup();
    const afterCode = nestedRoot.querySelectorAll('[data-plan-block-type="code"]')[1]!;
    const resolved = resolveAnchor(anchorForBlockElement(afterCode, nestedRoot).anchor, nestedRoot);
    expect(resolved?.toString()).toContain("after code");
    expect(resolved?.toString()).not.toContain("before code");
  });

  it("a selection inside a nested block yields a visual anchor for that block with the document-level section", () => {
    const nestedRoot = setup();
    const text = nestedRoot
      .querySelectorAll('[data-plan-block-type="code"]')[1]!
      .querySelector("span")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const res = anchorFromRange(range, nestedRoot);
    expect(res?.anchor.anchorKind).toBe("visual");
    expect(res?.anchor.sectionTitle).toBe("Before / After"); // document-level heading, not nesting-local
    const resolved = resolveAnchor(res!.anchor, nestedRoot);
    expect(resolved?.toString()).toContain("after code");
    expect(resolved?.toString()).not.toContain("before code");
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

/**
 * Wireframe/design artboards are positioned HTML in the live DOM, annotated by
 * node pin: `targetSelector` = the artboard, `targetNodeId` = a stable
 * `data-wf-node` id (renderer-stamped, a later wave), `targetNodePath` = a
 * structural nth-child fallback. This mirrors the spike's proven round-trip
 * (`wireframe-anchor-proof.html`, §7.2): capture → resolve exact node; survive a
 * re-render that inserts an element above the target via id match; detach when
 * the id is removed AND the path breaks.
 */
const WF_HTML = `<div data-plan-root>
  <figure data-plan-block-id="wf-1" data-plan-block-type="wireframe">
    <div>
      <label>Email</label>
      <button data-wf-node="submit-btn">Sign in</button>
    </div>
  </figure>
</div>`;

describe("anchoring — wireframe node pin", () => {
  function captureButtonPin() {
    document.body.innerHTML = WF_HTML;
    const wfRoot = document.querySelector("[data-plan-root]")!;
    const btn = wfRoot.querySelector('[data-wf-node="submit-btn"]')!;
    return { wfRoot, pin: anchorForWireframeNode(btn, wfRoot)! };
  }

  it("captures a node pin and resolves it back to the exact element", () => {
    const { wfRoot, pin } = captureButtonPin();
    expect(pin.anchor.anchorKind).toBe("wireframe");
    expect(pin.anchor.targetKind).toBe("wireframe");
    expect(pin.anchor.targetSelector).toBe('[data-plan-block-id="wf-1"]');
    expect(pin.anchor.targetNodeId).toBe("submit-btn");
    expect(pin.anchor.targetNodePath).toBeTruthy();
    expect(resolveAnchor(pin.anchor, wfRoot)?.toString()).toContain("Sign in");
  });

  it("survives a re-render that inserts a field above the target (id match)", () => {
    const { wfRoot, pin } = captureButtonPin();
    const btn = wfRoot.querySelector('[data-wf-node="submit-btn"]')!;
    const inserted = document.createElement("label");
    inserted.textContent = "Password";
    btn.parentElement!.insertBefore(inserted, btn); // shifts the structural path
    expect(resolveAnchor(pin.anchor, wfRoot)?.toString()).toContain("Sign in");
  });

  it("detaches (null) when the node id is removed AND the path is broken", () => {
    const { wfRoot, pin } = captureButtonPin();
    const artboard = wfRoot.querySelector('[data-plan-block-id="wf-1"]')!;
    artboard.innerHTML = "<div></div>"; // id gone + captured path no longer valid
    expect(resolveAnchor(pin.anchor, wfRoot)).toBeNull();
  });

  it("falls back to the structural path when no data-wf-node id exists", () => {
    document.body.innerHTML = `<div data-plan-root>
      <figure data-plan-block-id="wf-2" data-plan-block-type="design">
        <div><span>alpha</span><span>beta</span></div>
      </figure>
    </div>`;
    const wfRoot = document.querySelector("[data-plan-root]")!;
    const beta = wfRoot.querySelectorAll("span")[1]!;
    const pin = anchorForWireframeNode(beta, wfRoot)!;
    expect(pin.anchor.targetNodeId).toBeUndefined();
    expect(pin.anchor.targetNodePath).toBeTruthy();
    expect(resolveAnchor(pin.anchor, wfRoot)?.toString()).toContain("beta");
  });

  it("a selection inside an artboard yields a wireframe pin, not a text-quote", () => {
    document.body.innerHTML = WF_HTML;
    const wfRoot = document.querySelector("[data-plan-root]")!;
    const btnText = wfRoot.querySelector('[data-wf-node="submit-btn"]')!.firstChild!;
    const range = document.createRange();
    range.setStart(btnText, 0);
    range.setEnd(btnText, 4);
    const res = anchorFromRange(range, wfRoot);
    expect(res?.anchor.anchorKind).toBe("wireframe");
    expect(res?.anchor.targetNodeId).toBe("submit-btn");
  });
});

describe("anchoring — canvas board coordinate", () => {
  const stub: CanvasTransform = {
    boardToPixel: ({ x, y }) => ({ x: x / 2, y: y / 2 }),
    boardScale: 0.5,
  };

  it("resolves a region anchor to a pixel box via the transform", () => {
    const anchor = anchorForCanvasPoint({ x: 100, y: 200, width: 40, height: 20 });
    expect(anchor.anchorKind).toBe("canvas");
    expect(resolveCanvasAnchor(anchor, stub)).toEqual({ x: 50, y: 100, width: 20, height: 10 });
  });

  it("gives a point anchor (no size) a fallback footprint", () => {
    expect(resolveCanvasAnchor(anchorForCanvasPoint({ x: 10, y: 20 }), stub)).toEqual({
      x: 5,
      y: 10,
      width: 6,
      height: 6,
    });
  });

  it("returns null for a canvas anchor missing coordinates", () => {
    expect(resolveCanvasAnchor({ anchorKind: "canvas" }, stub)).toBeNull();
  });

  it("resolveAnchor returns null for canvas anchors (no DOM Range)", () => {
    document.body.innerHTML = `<div data-plan-root></div>`;
    const r = document.querySelector("[data-plan-root]")!;
    expect(resolveAnchor(anchorForCanvasPoint({ x: 1, y: 2 }), r)).toBeNull();
  });
});
