/** The wake id and tier table (Phase 3 plan "Wake tiers, ids and modes"), as built. */
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  attentionCommandId,
  briefNeededCommandId,
  briefReadParkCommandId,
  controlMessage,
  deadlockCommandId,
  digestCommandId,
  forkPrepareCommandId,
  kickoffCommandId,
  notifyCommandId,
  quiescentSubmitCommandId,
  stallNudgeCommandId,
  steerRedeliverCommandId,
  wakeNotification,
  yieldCommandId,
} from "./controlMessage.ts";

const child = ThreadId.make("child-1");
const parent = ThreadId.make("parent-1");

describe("control-message ids", () => {
  it.each([
    [kickoffCommandId(child), "server:workstream-kickoff:child-1"],
    [yieldCommandId(child, "event:recorded-1"), "server:workstream-yield:child-1:event:recorded-1"],
    [
      attentionCommandId(child, "needs_guidance", "event:raised-1"),
      "server:workstream-attention:child-1:needs_guidance:event:raised-1",
    ],
    [briefNeededCommandId(parent, "abc123"), "server:workstream-brief-needed:parent-1:abc123"],
    [deadlockCommandId(parent, "def456"), "server:workstream-deadlock:parent-1:def456"],
    [digestCommandId(parent, "0a1b2c"), "server:workstream-digest:parent-1:0a1b2c"],
    [
      stallNudgeCommandId(child, 1_700_000_000_000),
      "server:workstream-stall-nudge:child-1:1700000000000",
    ],
    [notifyCommandId("record-9"), "server:workstream-notify:record-9"],
    [forkPrepareCommandId(child), "server:loom:fork-prepare:child-1"],
    [briefReadParkCommandId(child), "server:loom:brief-read:child-1"],
    [quiescentSubmitCommandId(child, "run:7"), "server:loom:quiescent:child-1:run:7"],
    [steerRedeliverCommandId(child, "h4sh"), "server:loom:steer-redeliver:child-1:h4sh"],
  ])("%s", (built, expected) => {
    assert.equal(built, expected);
  });
});

describe("controlMessage", () => {
  it.each([
    ["steered", "queue_after_active"],
    ["fyi", "start_if_idle"],
  ] as const)("tier %s dispatches %s", (tier, mode) => {
    assert.equal(
      controlMessage({ threadId: child, id: "server:x", tier, origin: "control_notice", text: "t" })
        .dispatchMode.type,
      mode,
    );
  });

  it("is a server-created agent message whose id derives from the command id", () => {
    const notification = wakeNotification("A sub-thread yielded to you.");
    const payload = { kind: "yield", items: [{ title: "Yielded" }] } as const;
    assert.deepEqual(
      controlMessage({
        threadId: parent,
        id: yieldCommandId(child, "event:1"),
        tier: "steered",
        origin: "control_notice",
        text: "Yield text",
        payload,
        notification,
      }),
      {
        type: "message.dispatch",
        commandId: "server:workstream-yield:child-1:event:1",
        threadId: parent,
        messageId: "message:server:workstream-yield:child-1:event:1",
        text: "Yield text",
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
        loom: { origin: "control_notice", controlPayload: payload },
        notification,
      } as never,
    );
  });

  it("a kickoff carries the kickoff origin, no payload and no notification", () => {
    const kickoff = controlMessage({
      threadId: child,
      id: kickoffCommandId(child),
      tier: "steered",
      origin: "kickoff",
      text: "Brief.",
    });
    assert.deepEqual(kickoff.loom, { origin: "kickoff" });
    assert.notProperty(kickoff, "notification");
    assert.notProperty(kickoff, "deliveryIntent");
  });
});
