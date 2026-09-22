import { ThreadId, type ControlPayload } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";

import { ControlDigestCardView } from "./ControlDigestCard";
import {
  classifyControlMessage,
  controlSummaryLine,
  isCardedControlMessage,
} from "./controlMessages";

const RAW_TEXT = "FYI digest\n\n## Report\n\nThe whole body nobody asked for yet.";

const PAYLOAD: ControlPayload = {
  kind: "digest",
  heading: "FYI digest — 1 item completed.",
  items: [
    {
      threadId: ThreadId.make("child-1"),
      role: "coder",
      title: "Config loader landed",
      status: "done",
      icon: "☑️",
      timestamp: "2026-09-22 02:15Z",
    },
  ],
};

const rendered = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());

const clickButton = (tree: ReactTestRenderer, index: number) =>
  act(() => tree.root.findAllByType("button")[index]!.props.onClick());

describe("control message classification", () => {
  it("leaves human messages untouched and routes the payload-heavy origins to a card", () => {
    expect(classifyControlMessage({})).toBeNull();
    expect(classifyControlMessage({ origin: "human" })).toBeNull();
    expect(classifyControlMessage({ origin: "control_notice" })).toEqual({
      channel: "control-plane",
      label: "Control plane",
      payloadChannel: true,
    });
    expect(classifyControlMessage({ origin: "notify" })?.channel).toBe("inter-thread");
    // A brief and a steer are short and actionable: accented, never collapsed.
    expect(isCardedControlMessage({ origin: "kickoff", text: "x".repeat(900) })).toBe(false);
    expect(isCardedControlMessage({ origin: "orchestrator", text: "x".repeat(900) })).toBe(false);
    // A structured arrival always cards; a three-word notice never does.
    expect(
      isCardedControlMessage({ origin: "control_notice", text: "ok", controlPayload: PAYLOAD }),
    ).toBe(true);
    expect(isCardedControlMessage({ origin: "control_notice", text: "Rework round 2." })).toBe(
      false,
    );
    expect(isCardedControlMessage({ origin: "notify", text: "x".repeat(900) })).toBe(true);
  });

  it("summarises an unstructured notice with its first line of words", () => {
    expect(controlSummaryLine("\n\n## **Heading line**\n\nBody follows.")).toBe("Heading line");
    expect(controlSummaryLine(`x${"y".repeat(200)}`)).toHaveLength(160);
  });
});

describe("ControlDigestCardView", () => {
  it("keeps the payload out of the timeline until it is asked for", () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <ControlDigestCardView
          channel="control-plane"
          label="Control plane"
          payload={PAYLOAD}
          text={RAW_TEXT}
          cwd={undefined}
          threadRef={null}
          skills={[]}
          onOpenThread={null}
        />,
      );
    });
    // Collapsed: the heading and the one-line item, and nothing else.
    expect(rendered(tree)).toContain("Config loader landed");
    expect(rendered(tree)).not.toContain("2026-09-22 02:15Z");
    expect(rendered(tree)).not.toContain("nobody asked for");

    // Button 0 is the card header (expand), button 1 the raw-payload toggle.
    clickButton(tree, 0);
    expect(rendered(tree)).toContain("2026-09-22 02:15Z");

    // The raw toggle is the verbatim bytes the model received, never markdown.
    clickButton(tree, 1);
    expect(rendered(tree)).toContain("nobody asked for");
  });
});
