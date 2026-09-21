import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { listThreadsByProjectId, requireThread, requireThreadAbsent } from "./commandInvariants.ts";

const now = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  goals: [],
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      defaultStartFromOrigin: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      defaultStartFromOrigin: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      // loom: workstream fields on the thread shape.
      goalId: null,
      parentThreadId: null,
      role: null,
      purpose: null,
      brief: null,
      planLane: "planned" as const,
      attention: [],
      blockedBy: [],
      spawnGeneration: null,
      forkFromThreadId: null,
      continuesThreadId: null,
      reportPath: null,
      graphKey: null,
      kickoffBriefPath: null,
      routes: [],
      gateRounds: 0,
      pendingRework: false,
      lastOutcome: null,
      isolation: "shared" as const,
      fanInState: "none" as const,
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      cumulativeCostUsd: 0,
      toolUses: null,
      usedTokens: null,
      maxTokens: null,
      diffAdditions: null,
      diffDeletions: null,
      handoffDestinations: [],
      notifySendLog: [],
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      goalId: null,
      parentThreadId: null,
      role: null,
      purpose: null,
      brief: null,
      planLane: "planned" as const,
      attention: [],
      blockedBy: [],
      spawnGeneration: null,
      forkFromThreadId: null,
      continuesThreadId: null,
      reportPath: null,
      graphKey: null,
      kickoffBriefPath: null,
      routes: [],
      gateRounds: 0,
      pendingRework: false,
      lastOutcome: null,
      isolation: "shared" as const,
      fanInState: "none" as const,
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      cumulativeCostUsd: 0,
      toolUses: null,
      usedTokens: null,
      maxTokens: null,
      diffAdditions: null,
      diffDeletions: null,
      handoffDestinations: [],
      notifySendLog: [],
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("lists threads by project", () => {
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("lets a draft retry re-create a thread id after its first attempt was deleted", async () => {
    const threadId = ThreadId.make("thread-1");
    const firstAttempt = readModel.threads.find((thread) => thread.id === threadId)!;
    const afterRollback: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) =>
        thread.id === threadId ? { ...thread, deletedAt: now, updatedAt: now } : thread,
      ),
    };
    const retry: OrchestrationCommand = {
      type: "thread.create",
      commandId: CommandId.make("cmd-retry"),
      threadId,
      projectId: firstAttempt.projectId,
      title: firstAttempt.title,
      modelSelection: firstAttempt.modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
    };

    await expect(
      Effect.runPromise(
        requireThreadAbsent({ readModel: afterRollback, command: retry, threadId }),
      ),
    ).resolves.toBeUndefined();
  });
});
