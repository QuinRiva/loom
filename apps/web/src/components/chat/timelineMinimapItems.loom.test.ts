import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems } from "./timelineMinimapItems";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap previews (loom)", () => {
  // loom: agent-created user-role messages (control notices, steers) are not human prompts
  it("skips agent-created messages and spans the human turn past them", () => {
    const source = rows([
      ["user", "Do it"],
      ["assistant", "Started"],
      ["user", "[T3 Workstream control plane] child finished"],
      ["assistant", "All done"],
      ["user", "Thanks"],
    ]).map((row, index) =>
      index === 2 && row.kind === "message"
        ? { ...row, message: { ...row.message, createdBy: "agent" as const } }
        : row,
    );
    const items = deriveTimelineMinimapItems(source);
    expect(items.map((item) => item.userText)).toEqual(["Do it", "Thanks"]);
    expect(items[0]?.assistantText).toBe("All done");
  });
});
