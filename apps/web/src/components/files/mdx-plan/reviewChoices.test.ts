// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ReviewChoiceRead } from "./blocks/reviewChoice";
import {
  EMPTY_REVIEW_CHOICE,
  formatReviewChoiceText,
  isReviewChoiceCommentId,
  parseReviewChoiceDraft,
  type PlanReviewChoice,
  type PlanReviewChoicesApi,
  PlanReviewChoicesContext,
  reviewChoiceCommentId,
} from "./reviewChoices";

/**
 * The `<ReviewChoice>` decision channel — the tri-state sibling of the
 * question-answer channel. Covers the wire-truth helpers (comment id/prefix,
 * agent-facing prose, draft parsing) and the block's two modes: read-only
 * without a context, and upserting a choice through the context on click.
 */

describe("reviewChoices helpers", () => {
  it("formats verdict + note, using the comment verb for a note-only choice", () => {
    expect(formatReviewChoiceText("A-1", { verdict: "reject", note: "wrong gate" })).toBe(
      'Review A-1 → reject — "wrong gate"',
    );
    expect(formatReviewChoiceText("A-1", { verdict: "accept", note: "" })).toBe(
      "Review A-1 → accept",
    );
    expect(formatReviewChoiceText("A-1", { verdict: null, note: "let us talk" })).toBe(
      'Review A-1 → comment — "let us talk"',
    );
  });

  it("carries the mdx-review: prefix so overlays can filter these comments out", () => {
    const id = reviewChoiceCommentId("plans/x/plan.mdx", "a1");
    expect(id).toBe("mdx-review:plans/x/plan.mdx:a1");
    expect(isReviewChoiceCommentId(id)).toBe(true);
    expect(isReviewChoiceCommentId("mdx-anchor:1")).toBe(false);
  });

  it("parses choice drafts, degrading malformed input to undecided", () => {
    expect(parseReviewChoiceDraft(JSON.stringify({ verdict: "discuss", note: "n" }))).toEqual({
      verdict: "discuss",
      note: "n",
    });
    expect(parseReviewChoiceDraft("not json")).toEqual(EMPTY_REVIEW_CHOICE);
    expect(parseReviewChoiceDraft(JSON.stringify({ verdict: "bogus" }))).toEqual({
      verdict: null,
      note: "",
    });
  });
});

describe("<ReviewChoice> rendering", () => {
  it("renders read-only without a context (spans, no buttons)", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewChoiceRead, {
        data: { itemId: "a1", label: "A-1" },
        blockId: undefined,
      }),
    );
    expect(html).toContain('data-plan-block-type="review-choice"');
    expect(html).toContain("A-1");
    expect(html).not.toContain("<button");
  });

  it("upserts a choice through the context on a verdict click (and clears on re-click)", async () => {
    const calls: { itemId: string; choice: PlanReviewChoice }[] = [];
    // A stateful harness so setChoice re-renders (mirrors the real layer, whose
    // composer-store write triggers the re-render that feeds getChoice back in).
    function Harness() {
      const [current, setCurrent] = useState<PlanReviewChoice>(EMPTY_REVIEW_CHOICE);
      const api: PlanReviewChoicesApi = {
        getChoice: () => current,
        setChoice: (item, _blockElement, choice) => {
          calls.push({ itemId: item.itemId, choice });
          setCurrent(choice);
        },
      };
      return createElement(
        PlanReviewChoicesContext.Provider,
        { value: api },
        createElement(ReviewChoiceRead, {
          data: { itemId: "a1", label: "A-1" },
          blockId: undefined,
        }),
      );
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness));
    });

    const reject = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reject",
    )!;
    await act(async () => {
      reject.click();
    });
    expect(calls.at(-1)!.itemId).toBe("a1");
    expect(calls.at(-1)!.choice.verdict).toBe("reject");
    expect(formatReviewChoiceText("A-1", calls.at(-1)!.choice)).toContain("reject");

    // Clicking the same verdict again clears it (tri-state toggle).
    await act(async () => {
      reject.click();
    });
    expect(calls.at(-1)!.choice.verdict).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
