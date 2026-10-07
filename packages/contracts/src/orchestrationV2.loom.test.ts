import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  isLoomCommand,
  isLoomDomainEvent,
  isLoomGoalShellStreamItem,
  LOOM_COMMAND_TYPES,
  LOOM_EVENT_TYPES,
  loomCommandThreadId,
  type LoomCommand,
  LoomMessageFields,
  makeLoomInternalCommandMembers,
} from "./orchestrationV2.loom.ts";
import {
  OrchestrationV2Command,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2SubscribeShellInput,
  OrchestrationV2ThreadShellJson,
  OrchestrationV2UserInputQuestion,
} from "./orchestrationV2.ts";

const now = "2026-10-05T00:00:00.000Z";
const decodeEventJson = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const encodeEventJson = Schema.encodeSync(OrchestrationV2DomainEventJson);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const decodeShellJson = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeMessageJson = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);
const decodeSubscribeShellInput = Schema.decodeUnknownSync(OrchestrationV2SubscribeShellInput);
const decodeShellStreamItem = Schema.decodeUnknownSync(OrchestrationV2ShellStreamItem);

const typeLiterals = (members: ReadonlyArray<Schema.Top>, key: "type" | "kind") =>
  members.flatMap((member) => {
    const field = (member as unknown as { fields: Record<string, unknown> }).fields[key] as {
      literal?: string;
      literals?: ReadonlyArray<string>;
    };
    return field.literals ?? [field.literal!];
  });

const loomEventJson = {
  id: "event-1",
  threadId: "child-1",
  occurredAt: now,
  type: "thread.workstream-created",
  payload: {
    parentThreadId: "root-1",
    rootThreadId: "root-1",
    projectId: "project-1",
    goalId: "goal-1",
    anchorTaskId: null,
    role: "coder",
    purpose: "Writes the thing.",
    graphKey: "coder",
    kickoffBriefPath: null,
    held: false,
    blockedBy: [],
    routes: [{ on: ["needs_rework"], kind: "loop", to: "reviewer-1", maxRounds: 2 }],
    spawnGeneration: "run-1",
    forkFromThreadId: null,
    continuesThreadId: null,
  },
};

const shellJson = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  providerInstanceId: "pi",
  modelSelection: { instanceId: "pi", model: "claude-opus" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
};

const workstreamJson = {
  threadId: "thread-1",
  projectId: "project-1",
  goalId: null,
  anchorTaskId: null,
  parentThreadId: null,
  rootThreadId: "thread-1",
  role: "orchestrator",
  purpose: null,
  graphKey: null,
  kickoffBriefPath: null,
  held: false,
  heldSince: null,
  outcome: null,
  outcomeAt: null,
  kickoffAt: now,
  attention: ["awaiting_orchestrator"],
  blockedBy: [],
  dependenciesSince: null,
  spawnGeneration: null,
  forkFromThreadId: null,
  continuesThreadId: null,
  routes: [],
  gateRounds: 0,
  pendingRework: false,
  lastOutcome: {
    outcome: "quiescent",
    decision: "yield",
    round: 0,
    eventId: null,
    at: now,
  },
  reportPath: null,
  archivedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

describe("Loom sidecar contract splices", () => {
  it("never shadows an upstream member: every type/kind literal is unique in each spliced union", () => {
    for (const [members, key] of [
      [OrchestrationV2DomainEvent.members, "type"],
      [OrchestrationV2DomainEventJson.members, "type"],
      [OrchestrationV2Command.members, "type"],
      [OrchestrationV2ShellStreamItem.members, "kind"],
    ] as const) {
      const literals = typeLiterals(members, key);
      expect(new Set(literals).size).toBe(literals.length);
    }
    expect(typeLiterals(OrchestrationV2DomainEvent.members, "type")).toEqual(
      expect.arrayContaining([...LOOM_EVENT_TYPES]),
    );
  });

  it("round-trips a Loom event through the persisted JSON union and decodes it as a domain event", () => {
    const decoded = decodeEventJson(loomEventJson);
    expect(isLoomDomainEvent(decoded)).toBe(true);
    expect(DateTime.formatIso(decoded.occurredAt)).toBe(now);
    expect(encodeEventJson(decoded)).toEqual(loomEventJson);
    const event = decodeEvent({
      ...loomEventJson,
      occurredAt: DateTime.makeUnsafe(now),
    });
    expect(event.type).toBe("thread.workstream-created");
  });

  it("decodes a thread shell without workstream, and with one (summaries default, store-only fields stripped)", () => {
    expect(decodeShellJson(shellJson).workstream).toBeUndefined();
    const joined = decodeShellJson({
      ...shellJson,
      workstream: { ...workstreamJson, notifySendLog: [], attentionEpisodes: {} },
    });
    expect(joined.workstream?.consults).toEqual([]);
    expect(joined.workstream?.lastOutcome?.eventId).toBeNull();
    expect(joined.workstream).not.toHaveProperty("notifySendLog");
    expect(joined.workstream).not.toHaveProperty("attentionEpisodes");
  });

  it("carries loom fields and start_if_idle on message.dispatch, and loom on the message record", () => {
    const command = decodeCommand({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: "server:loom:digest:1",
      threadId: "root-1",
      messageId: "message-1",
      text: "FYI",
      attachments: [],
      loom: { origin: "control_notice", controlPayload: { kind: "digest", items: [] } },
      notification: { source: { kind: "background_task" }, outcome: "updated", summary: "FYI" },
      dispatchMode: { type: "start_if_idle" },
    });
    expect(command.type === "message.dispatch" && command.dispatchMode.type).toBe("start_if_idle");
    const message = decodeMessageJson({
      createdBy: "user",
      creationSource: "web",
      id: "message-2",
      threadId: "root-1",
      runId: null,
      nodeId: null,
      role: "user",
      text: "hi",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      loom: { humanAuthored: true },
    });
    expect(message.loom).toEqual({ humanAuthored: true });
  });

  it("splices client Loom commands and the subscribe flag, and keeps goal items unsequenced", () => {
    const command = decodeCommand({
      type: "thread.dependencies.set",
      commandId: "command-1",
      threadId: "child-1",
      parentThreadId: "root-1",
      blockedBy: ["child-2"],
      createdAt: now,
    });
    expect(isLoomCommand(command)).toBe(true);
    expect(loomCommandThreadId(command as LoomCommand)).toBe("root-1");
    expect(decodeSubscribeShellInput({ loom: true })).toEqual({
      loom: true,
    });
    const item = decodeShellStreamItem({
      kind: "goal.removed",
      goalId: "goal-1",
    });
    expect(isLoomGoalShellStreamItem(item)).toBe(true);
    expect(item).not.toHaveProperty("sequence");
  });

  it("isLoomCommand refuses an unknown or upstream command type", () => {
    expect(isLoomCommand({ type: "thread.plan-lane.set" })).toBe(false);
    expect(isLoomCommand({ type: "thread.fork" })).toBe(false);
    expect(LOOM_COMMAND_TYPES.every((type) => isLoomCommand({ type }))).toBe(true);
  });

  it("locks spawn and scaffold on the parent, fork.prepare on the child", () => {
    const base = { commandId: "c", createdAt: now } as const;
    const lock = (command: Record<string, unknown>) =>
      loomCommandThreadId(command as unknown as LoomCommand);
    expect(lock({ ...base, type: "thread.spawn", threadId: "child", parentThreadId: "root" })).toBe(
      "root",
    );
    expect(lock({ ...base, type: "thread.spawn", threadId: "root2", parentThreadId: null })).toBe(
      "root2",
    );
    expect(lock({ ...base, type: "thread.scaffold", threadId: "root", nodes: [] })).toBe("root");
    expect(
      lock({ ...base, type: "thread.fork.prepare", threadId: "child", sourceThreadId: "src" }),
    ).toBe("child");
  });

  it("round-trips the Phase 3 control payload fields and still decodes a V1-shaped payload", () => {
    const fields = Schema.decodeUnknownSync(LoomMessageFields);
    const encode = Schema.encodeSync(LoomMessageFields);
    const v1 = {
      origin: "control_notice",
      controlPayload: {
        kind: "digest",
        heading: "Two sub-threads finished",
        items: [{ threadId: "child-1", title: "Coder", status: "done", reportPath: "/r.md" }],
      },
    };
    expect(encode(fields(v1))).toEqual(v1);
    for (const controlPayload of [
      {
        kind: "digest",
        items: [
          { kind: "gate-resolved", title: "Gate resolved" },
          { kind: "dead-episode", threadId: "child-2", title: "Reviewer" },
        ],
      },
      { kind: "notice", notice: "gate-rework", heading: "Rework", items: [] },
      { kind: "yield", synthesised: true, items: [{ kind: "terminal", title: "Coder" }] },
    ]) {
      expect(encode(fields({ origin: "control_notice", controlPayload }))).toEqual({
        origin: "control_notice",
        controlPayload,
      });
    }
    expect(() =>
      fields({ controlPayload: { kind: "notice", notice: "bogus", items: [] } }),
    ).toThrow();
  });

  it("carries runtime-request.create as an internal command only, locked on the asker", () => {
    const create = {
      type: "runtime-request.create",
      commandId: "server:loom:ask:1",
      threadId: "root-1",
      createdAt: now,
      requestId: "loom-ask:1",
      questions: [
        {
          id: "q1",
          header: "Scope",
          question: "Ship it?",
          options: [{ label: "Yes", description: "Ship now." }],
        },
      ],
    };
    const member = Schema.Union(
      makeLoomInternalCommandMembers({}, OrchestrationV2UserInputQuestion),
    );
    const decoded = Schema.decodeUnknownSync(member)(create);
    expect(Schema.encodeSync(member)(decoded)).toEqual(create);
    expect(isLoomCommand(decoded)).toBe(true);
    expect(loomCommandThreadId(decoded as LoomCommand)).toBe("root-1");
    expect(() => decodeCommand(create)).toThrow();
  });
});
