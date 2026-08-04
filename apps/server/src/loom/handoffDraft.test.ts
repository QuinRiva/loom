import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  HANDOFF_DRAFTER_ROLE,
  appendDrafterConsultPointer,
  buildDrafterKickoffPrompt,
  buildDrafterTitle,
  buildHandoffDraftTurnStart,
  capturedDrafterSelectionCandidate,
} from "./handoffDraft.ts";
import type { LaunchIdentityRecord } from "../orchestration/workstreamLaunchIdentity.ts";

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

const makeSource = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  ({
    id: "source" as ThreadId,
    projectId: ProjectId.make("project"),
    goalId: null,
    parentThreadId: null,
    role: null,
    purpose: null,
    brief: null,
    planLane: "in_progress",
    attention: [],
    blockedBy: [],
    routes: [],
    isolation: "shared",
    fanInState: "none",
    spawnGeneration: null,
    forkFromThreadId: null,
    continuesThreadId: null,
    reportPath: null,
    graphKey: null,
    kickoffBriefPath: null,
    handoffDestinations: [],
    title: "Source thread",
    titleProvenance: "curated",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/work/source",
    latestTurn: null,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  }) as OrchestrationThread;

describe("buildDrafterTitle", () => {
  it("prefixes and passes through a short explanation", () => {
    expect(buildDrafterTitle("the retry logic in FooService is broken")).toBe(
      "Handoff: the retry logic in FooService is broken",
    );
  });

  it("collapses whitespace and truncates a long explanation with an ellipsis", () => {
    const title = buildDrafterTitle(
      "the   retry logic in FooService is broken and also the cache eviction is wrong",
    );
    expect(title.startsWith("Handoff: ")).toBe(true);
    expect(title).toContain("\u2026");
    // ~50 chars of explanation + the "Handoff: " prefix.
    expect(title.length).toBeLessThanOrEqual("Handoff: ".length + 50);
  });
});

describe("appendDrafterConsultPointer", () => {
  it("appends a consult pointer to the drafter's frozen fork", () => {
    const decorated = appendDrafterConsultPointer("Fix the retry logic.", "drafter-9" as ThreadId);
    expect(decorated.startsWith("Fix the retry logic.")).toBe(true);
    expect(decorated).toContain("drafter-9");
    expect(decorated).toContain("consult_thread");
    expect(decorated).toContain("frozen fork");
  });
});

describe("buildDrafterKickoffPrompt", () => {
  it("embeds the explanation and the load-bearing instructions", () => {
    const prompt = buildDrafterKickoffPrompt("fix the retry logic");
    expect(prompt).toContain("fix the retry logic");
    expect(prompt).toContain("goal_handoff");
    expect(prompt).toContain("Do NOT do the work");
    expect(prompt).toContain("consult this frozen session");
    expect(prompt).toContain("End your turn");
  });
});

describe("capturedDrafterSelectionCandidate", () => {
  it("returns undefined without a record", () => {
    expect(capturedDrafterSelectionCandidate(undefined)).toBeUndefined();
  });

  it("returns undefined when the record has no applied model", () => {
    const record: LaunchIdentityRecord = {
      providerInstanceId: "codex",
      model: undefined,
      options: undefined,
      appendSystemPrompt: undefined,
      tools: undefined,
      skills: undefined,
    };
    expect(capturedDrafterSelectionCandidate(record)).toBeUndefined();
  });

  it("maps the captured instance, model, and options", () => {
    const record: LaunchIdentityRecord = {
      providerInstanceId: "codex",
      model: "gpt-5.4",
      options: [{ id: "thinkingLevel", value: "high" }],
      appendSystemPrompt: "…",
      tools: undefined,
      skills: undefined,
    };
    expect(capturedDrafterSelectionCandidate(record)).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [{ id: "thinkingLevel", value: "high" }],
    });
  });

  it("omits an empty options array", () => {
    const record: LaunchIdentityRecord = {
      providerInstanceId: "codex",
      model: "gpt-5.4",
      options: [],
      appendSystemPrompt: undefined,
      tools: undefined,
      skills: undefined,
    };
    expect(capturedDrafterSelectionCandidate(record)).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
    });
  });
});

describe("buildHandoffDraftTurnStart", () => {
  const command = buildHandoffDraftTurnStart({
    source: makeSource(),
    explanation: "fix the retry logic",
    drafterThreadId: "drafter" as ThreadId,
    modelSelection,
    commandId: CommandId.make("server:handoff-draft:abc"),
    messageId: MessageId.make("msg-1"),
    now: "2026-07-19T12:34:56.000Z",
  });

  it("mints a ROOT fork drafter via bootstrap.createThread", () => {
    const create = command.bootstrap?.createThread;
    expect(create).toBeDefined();
    expect(create?.parentThreadId).toBeNull();
    expect(create?.role).toBe(HANDOFF_DRAFTER_ROLE);
    expect(create?.forkFromThreadId).toBe("source");
    expect(create?.titleProvenance).toBe("curated");
    expect(create?.title).toBe("Handoff: fix the retry logic");
  });

  it("injects the drafter kickoff as the first turn with kickoff origin + setInProgress", () => {
    expect(command.message.origin).toBe("kickoff");
    expect(command.message.text).toContain("fix the retry logic");
    expect(command.setInProgress).toBe(true);
    expect(command.threadId).toBe("drafter");
  });

  it("seeds the resolved model selection on both the turn and the created thread", () => {
    expect(command.modelSelection).toEqual(modelSelection);
    expect(command.bootstrap?.createThread?.modelSelection).toEqual(modelSelection);
  });

  it("inherits the source's goal, worktree, and runtime", () => {
    const source = makeSource({ goalId: null, branch: "main", worktreePath: "/work/source" });
    const cmd = buildHandoffDraftTurnStart({
      source,
      explanation: "x",
      drafterThreadId: "drafter" as ThreadId,
      modelSelection,
      commandId: CommandId.make("server:handoff-draft:abc"),
      messageId: MessageId.make("msg-1"),
      now: "2026-07-19T12:34:56.000Z",
    });
    expect(cmd.bootstrap?.createThread?.branch).toBe("main");
    expect(cmd.bootstrap?.createThread?.worktreePath).toBe("/work/source");
    expect(cmd.runtimeMode).toBe("full-access");
  });
});
