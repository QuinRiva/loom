import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { wakeNotification } from "../loom/orchestration/dispatcher/controlMessage.ts";
import { notificationTurnItem } from "./Notification.ts";

const now = DateTime.makeUnsafe("2026-10-06T00:00:00.000Z");
const delivery: OrchestrationV2TurnItem = {
  id: TurnItemId.make("item:digest"),
  threadId: ThreadId.make("thread:parent"),
  runId: RunId.make("run:digest"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "user_message",
  messageId: MessageId.make("message:digest"),
  inputIntent: "turn_start",
  text: "[T3 Workstream control plane] FYI digest",
  attachments: [],
  createdBy: "agent",
  creationSource: "server",
};
const notification = wakeNotification("FYI: 1 workstream update");

// DL-613: a Loom wake's notification marks the message automatic, but its item
// stays the message row the timeline renders as the control card.
it("keeps a Loom control wake's item as its message, and projects any other wake", () => {
  assert.strictEqual(
    notificationTurnItem(delivery, { notification, loom: { origin: "control_notice" } }, []),
    delivery,
  );
  assert.equal(notificationTurnItem(delivery, { notification }, []).type, "notification");
});
