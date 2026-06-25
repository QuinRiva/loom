import {
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type ThreadId,
  type ThreadStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectThreadsToDispatch } from "./WorkstreamDispatcher.ts";

const now = "2026-06-24T00:00:00.000Z";

const shell = (
  overrides: Omit<Partial<OrchestrationThreadShell>, "id"> & { readonly id: string },
): OrchestrationThreadShell =>
  ({
    projectId: "project-1",
    goalId: null,
    parentThreadId: "parent-1" as ThreadId,
    role: "coder",
    purpose: "do the thing",
    status: "planned" as ThreadStatus,
    blockedBy: [],
    title: "Sub-thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
    id: overrides.id as ThreadId,
  }) as OrchestrationThreadShell;

const ids = (threads: ReadonlyArray<OrchestrationThreadShell>) => threads.map((t) => t.id).sort();

describe("selectThreadsToDispatch", () => {
  it("promotes an un-started sub-thread with no dependencies", () => {
    expect(ids(selectThreadsToDispatch([shell({ id: "child-1" })]))).toEqual(["child-1"]);
  });

  it("ignores root threads (no parentThreadId)", () => {
    expect(selectThreadsToDispatch([shell({ id: "root-1", parentThreadId: null })])).toEqual([]);
  });

  it("does not promote a sub-thread that already has a started turn", () => {
    expect(selectThreadsToDispatch([shell({ id: "child-1", latestUserMessageAt: now })])).toEqual(
      [],
    );
  });

  it("does not promote a sub-thread that already has a provider session", () => {
    expect(
      selectThreadsToDispatch([
        shell({
          id: "child-1",
          session: {
            threadId: "child-1" as ThreadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            queuedMessages: { steering: [], followUp: [] },
            updatedAt: now,
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("gates a sub-thread until every dependency is done (review does not release)", () => {
    const threads = [
      shell({ id: "dep-coder", status: "review", latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(selectThreadsToDispatch(threads)).toEqual([]);
  });

  it("promotes the dependent once its dependency is done", () => {
    const threads = [
      shell({ id: "dep-coder", status: "done", latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-reviewer"]);
  });

  it("does not gate on a non-sibling dependency (different parentThreadId)", () => {
    const threads = [
      shell({
        id: "cousin-coder",
        parentThreadId: "other-parent" as ThreadId,
        status: "running",
        latestUserMessageAt: now,
      }),
      shell({ id: "child-reviewer", blockedBy: ["cousin-coder" as ThreadId] }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-reviewer"]);
  });

  it("treats self-refs and dangling dependency ids as non-gating", () => {
    const threads = [
      shell({
        id: "child-1",
        blockedBy: ["child-1" as ThreadId, "ghost-thread" as ThreadId],
      }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-1"]);
  });

  it("skips sub-threads missing the role/purpose needed for a kick-off", () => {
    expect(selectThreadsToDispatch([shell({ id: "child-1", purpose: null })])).toEqual([]);
  });
});
