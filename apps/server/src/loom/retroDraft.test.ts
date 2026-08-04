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
  RETRO_BRIEF_PATH,
  RETRO_REVIEWER_ROLE,
  buildRetroDraftTurnStart,
  buildRetroKickoffPrompt,
  buildRetroTitle,
} from "./retroDraft.ts";

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
    title: "Web HTML artefact viewer",
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

describe("buildRetroTitle", () => {
  it("prefixes and passes through a short source title", () => {
    expect(buildRetroTitle("Web HTML artefact viewer")).toBe("Retro: Web HTML artefact viewer");
  });

  it("collapses whitespace and truncates a long title with an ellipsis", () => {
    const title = buildRetroTitle(
      "A   very long source thread title that runs well past the fifty character budget",
    );
    expect(title.startsWith("Retro: ")).toBe(true);
    expect(title).toContain("\u2026");
    expect(title.length).toBeLessThanOrEqual("Retro: ".length + 50);
  });
});

describe("buildRetroKickoffPrompt", () => {
  it("points at the on-disk brief and defaults the focus to general", () => {
    const prompt = buildRetroKickoffPrompt(undefined);
    expect(prompt).toContain(RETRO_BRIEF_PATH);
    expect(prompt).toContain("Focus: general");
    expect(prompt).toContain("retrospective reviewer");
  });

  it("embeds an explicit focus", () => {
    expect(buildRetroKickoffPrompt("the rework loop on the coder child")).toContain(
      "Focus: the rework loop on the coder child",
    );
  });
});

describe("buildRetroDraftTurnStart", () => {
  const command = buildRetroDraftTurnStart({
    source: makeSource(),
    focus: "gate outcomes",
    reviewerThreadId: "reviewer" as ThreadId,
    modelSelection,
    commandId: CommandId.make("server:retro-draft:abc"),
    messageId: MessageId.make("msg-1"),
    now: "2026-07-19T12:34:56.000Z",
  });

  it("mints a ROOT fork reviewer via bootstrap.createThread", () => {
    const create = command.bootstrap?.createThread;
    expect(create).toBeDefined();
    expect(create?.parentThreadId).toBeNull();
    expect(create?.role).toBe(RETRO_REVIEWER_ROLE);
    expect(create?.forkFromThreadId).toBe("source");
    expect(create?.titleProvenance).toBe("curated");
    expect(create?.title).toBe("Retro: Web HTML artefact viewer");
  });

  it("injects the retro kickoff as the first turn with kickoff origin + setInProgress", () => {
    expect(command.message.origin).toBe("kickoff");
    expect(command.message.text).toContain("gate outcomes");
    expect(command.message.text).toContain(RETRO_BRIEF_PATH);
    expect(command.setInProgress).toBe(true);
    expect(command.threadId).toBe("reviewer");
  });

  it("inherits the source's goal, worktree, runtime, and model selection", () => {
    const create = command.bootstrap?.createThread;
    expect(create?.branch).toBe("main");
    expect(create?.worktreePath).toBe("/work/source");
    expect(create?.modelSelection).toEqual(modelSelection);
    expect(command.modelSelection).toEqual(modelSelection);
    expect(command.runtimeMode).toBe("full-access");
  });
});
