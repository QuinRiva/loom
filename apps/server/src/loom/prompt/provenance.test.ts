import { describe, expect, it } from "vite-plus/test";

import { AUTHOR_LABELS, authorLabel, isSlashCommand, labelledForModel } from "./provenance.ts";

const base = {
  messageId: "message:1",
  creationSource: "server",
  loom: { humanAuthored: false },
} as const;

// A root kickoff without a sender is the server's own text (the `/handoff` and
// `/retro` drafters); only a kickoff that names its sender is another agent's brief.
describe("authorLabel — root kickoffs", () => {
  it("labels a server-written drafter kickoff as automation, not another agent's brief", () => {
    expect(
      authorLabel({
        ...base,
        text: "You are a handoff drafter…",
        createdBy: "agent",
        loom: { origin: "kickoff", humanAuthored: false },
        hasParent: false,
      }),
    ).toBe(AUTHOR_LABELS.automation);
  });

  it("labels a goal_handoff / goal_continue root brief with its sending agent", () => {
    for (const origin of [undefined, "kickoff"] as const) {
      expect(
        authorLabel({
          ...base,
          text: "## Charter",
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: "thread:predecessor",
          loom: { origin, humanAuthored: false },
          hasParent: false,
        }),
      ).toBe(AUTHOR_LABELS.agentRoot("thread:predecessor"));
    }
  });

  it("still labels a child's kickoff as its parent's", () => {
    expect(
      authorLabel({
        ...base,
        text: "Your brief…",
        createdBy: "agent",
        loom: { origin: "kickoff", humanAuthored: false },
        hasParent: true,
      }),
    ).toBe(AUTHOR_LABELS.parent);
  });
});

// Only a real command bypasses the label: text that merely starts with a path is
// labelled, so a parent's "/home/x/y.ts is wrong" cannot read as the human's.
describe("slash-command bypass", () => {
  it("recognises commands and skill references, not paths", () => {
    for (const command of ["/compact", "/handoff fix the thing", "/skill:review the diff"])
      expect(isSlashCommand(command), command).toBe(true);
    for (const text of ["/home/carl/x.ts is wrong", "/tmp/out.json has 3 rows", "see /etc"])
      expect(isSlashCommand(text), text).toBe(false);
  });

  it("sends a parent's command bare but labels a parent's path-leading steer", () => {
    const parent = (text: string) =>
      labelledForModel({
        ...base,
        text,
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: "thread:parent",
        loom: { origin: "orchestrator", humanAuthored: false },
        hasParent: true,
      });
    expect(parent("/skill:review the diff")).toBe("/skill:review the diff");
    expect(parent("/home/carl/x.ts is wrong")).toBe(
      `${AUTHOR_LABELS.parent}\n\n/home/carl/x.ts is wrong`,
    );
  });
});
