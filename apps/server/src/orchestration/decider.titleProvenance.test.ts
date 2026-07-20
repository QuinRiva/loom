import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  GoalId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TitleProvenance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

// loom: §4 title-provenance guard + §2 goal-attach-down cascade coverage.

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asGoalId = (value: string): GoalId => GoalId.make(value);

const now = "2026-01-01T00:00:00.000Z";
const projectId = asProjectId("project-title-prov");
const goalId = asGoalId("goal-title-prov");

const seedThread = (
  readModel: Parameters<typeof projectEvent>[0],
  sequence: number,
  id: string,
  parentThreadId: string | null,
  opts: { goalId?: GoalId | null; titleProvenance?: TitleProvenance } = {},
) =>
  projectEvent(readModel, {
    sequence,
    eventId: asEventId(`evt-thread-${id}`),
    aggregateKind: "thread",
    aggregateId: asThreadId(id),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId(`cmd-thread-${id}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-thread-${id}`),
    metadata: {},
    payload: {
      threadId: asThreadId(id),
      projectId,
      goalId: opts.goalId === undefined ? goalId : opts.goalId,
      parentThreadId: parentThreadId === null ? null : asThreadId(parentThreadId),
      title: `Thread ${id}`,
      ...(opts.titleProvenance !== undefined ? { titleProvenance: opts.titleProvenance } : {}),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

const seedBase = (goalTitleProvenance: TitleProvenance) =>
  Effect.gen(function* () {
    let readModel = yield* projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-project"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: now,
      commandId: asCommandId("cmd-project"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project"),
      metadata: {},
      payload: {
        projectId,
        title: "Title Provenance",
        workspaceRoot: "/tmp/title-prov",
        defaultModelSelection: null,
        defaultStartFromOrigin: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    readModel = yield* projectEvent(readModel, {
      sequence: 2,
      eventId: asEventId("evt-goal"),
      aggregateKind: "goal",
      aggregateId: goalId,
      type: "goal.created",
      occurredAt: now,
      commandId: asCommandId("cmd-goal"),
      causationEventId: null,
      correlationId: asCommandId("cmd-goal"),
      metadata: {},
      payload: {
        goalId,
        projectId,
        slug: "title-prov",
        title: "Curated Goal Title",
        titleProvenance: goalTitleProvenance,
        description: "",
        createdAt: now,
        updatedAt: now,
      },
    });
    return readModel;
  });

const decideEvents = Effect.fnUntraced(function* (
  readModel: Parameters<typeof projectEvent>[0],
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
) {
  const decided = yield* decideOrchestrationCommand({ command, readModel });
  return Array.isArray(decided) ? decided : [decided];
});

type MetaEvent = { type: string; payload: { threadId?: ThreadId; title?: string } };

it.layer(NodeServices.layer)("decider title provenance", (it) => {
  it.effect("a derived thread rename never clobbers a curated goal title", () =>
    Effect.gen(function* () {
      let readModel = yield* seedBase("curated");
      readModel = yield* seedThread(readModel, 3, "root", null, { titleProvenance: "seed" });

      const events = (yield* decideEvents(readModel, {
        type: "thread.meta.update",
        commandId: asCommandId("cmd-rename"),
        threadId: asThreadId("root"),
        title: "LLM Interpreted Title",
        titleProvenance: "derived",
      })) as MetaEvent[];

      // The derived title replaces the thread's seed title …
      const threadMeta = events.find(
        (e) => e.type === "thread.meta-updated" && e.payload.threadId === asThreadId("root"),
      );
      expect(threadMeta?.payload.title).toBe("LLM Interpreted Title");
      // … but the curated goal title is left untouched (no cascade).
      expect(events.some((e) => e.type === "goal.meta-updated")).toBe(false);
    }),
  );

  it.effect("a derived thread rename does cascade to a derived goal title", () =>
    Effect.gen(function* () {
      let readModel = yield* seedBase("derived");
      readModel = yield* seedThread(readModel, 3, "root", null, { titleProvenance: "seed" });

      const events = (yield* decideEvents(readModel, {
        type: "thread.meta.update",
        commandId: asCommandId("cmd-rename"),
        threadId: asThreadId("root"),
        title: "Better Title",
        titleProvenance: "derived",
      })) as MetaEvent[];

      const goalMeta = events.find((e) => e.type === "goal.meta-updated");
      expect(goalMeta?.payload.title).toBe("Better Title");
    }),
  );

  it.effect("a seed title cannot replace a curated thread title", () =>
    Effect.gen(function* () {
      let readModel = yield* seedBase("curated");
      readModel = yield* seedThread(readModel, 3, "root", null, { titleProvenance: "curated" });

      const events = (yield* decideEvents(readModel, {
        type: "thread.meta.update",
        commandId: asCommandId("cmd-seed"),
        threadId: asThreadId("root"),
        title: "raw first message seed",
        titleProvenance: "seed",
      })) as MetaEvent[];

      const threadMeta = events.find((e) => e.type === "thread.meta-updated");
      // The event is still emitted (for updatedAt) but the title is dropped.
      expect(threadMeta).toBeDefined();
      expect(threadMeta?.payload.title).toBeUndefined();
    }),
  );

  it.effect("attaching a goal cascades down to goal-less descendants", () =>
    Effect.gen(function* () {
      // Root + child + grandchild all start goal-less (spawned during the
      // parent's goal-less window).
      let readModel = yield* seedBase("curated");
      readModel = yield* seedThread(readModel, 3, "root", null, { goalId: null });
      readModel = yield* seedThread(readModel, 4, "child", "root", { goalId: null });
      readModel = yield* seedThread(readModel, 5, "grandchild", "child", { goalId: null });

      const events = yield* decideEvents(readModel, {
        type: "thread.meta.update",
        commandId: asCommandId("cmd-attach"),
        threadId: asThreadId("root"),
        goalId,
      });

      const attached = new Set(
        events
          .filter(
            (e) =>
              e.type === "thread.meta-updated" &&
              (e.payload as { goalId?: GoalId }).goalId === goalId,
          )
          .map((e) => (e.payload as { threadId: ThreadId }).threadId),
      );
      expect(attached).toEqual(new Set(["root", "child", "grandchild"].map(asThreadId)));
    }),
  );

  it.effect("attaching a goal never overrides a descendant that already has one", () =>
    Effect.gen(function* () {
      const otherGoalId = asGoalId("goal-other");
      let readModel = yield* seedBase("curated");
      readModel = yield* seedThread(readModel, 3, "root", null, { goalId: null });
      // child already belongs to another goal — must be left alone.
      readModel = yield* seedThread(readModel, 4, "child", "root", { goalId: otherGoalId });

      const events = yield* decideEvents(readModel, {
        type: "thread.meta.update",
        commandId: asCommandId("cmd-attach"),
        threadId: asThreadId("root"),
        goalId,
      });

      const childMeta = events.find(
        (e) =>
          e.type === "thread.meta-updated" &&
          (e.payload as { threadId: ThreadId }).threadId === asThreadId("child"),
      );
      expect(childMeta).toBeUndefined();
    }),
  );
});
