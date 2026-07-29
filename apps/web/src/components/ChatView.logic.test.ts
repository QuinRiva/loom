import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import type { Thread } from "../types";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildThreadTurnInterruptInput,
  createLocalDispatchSnapshot,
  decideHandoffSend,
  deriveComposerSendState,
  HANDOFF_BLOCKED_CONTEXT_MESSAGE,
  HANDOFF_EMPTY_EXPLANATION_MESSAGE,
  RETRO_BLOCKED_CONTEXT_MESSAGE,
  decideRetroSend,
  dismissBranchMismatchForSession,
  getStartedThreadModelChangeBlockReason,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  runComposerDraftIntercept,
  shouldRestoreSubmittedDraft,
  shouldShowBranchMismatchBanner,
  shouldWriteThreadErrorToCurrentServerThread,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    goalId: null,
    parentThreadId: null,
    role: null,
    purpose: null,
    brief: null,
    planLane: "planned",
    attention: [],
    blockedBy: [],
    spawnGeneration: null,
    forkFromThreadId: null,
    reportPath: null,
    graphKey: null,
    kickoffBriefPath: null,
    routes: [],
    gateRounds: 0,
    pendingRework: false,
    lastOutcome: null,
    isolation: "shared" as const,
    fanInState: "none" as const,
    toolUses: null,
    usedTokens: null,
    maxTokens: null,
    diffAdditions: null,
    diffDeletions: null,
    handoffCount: 0,
    notifySendLog: [],
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  queuedMessages: { steering: [], followUp: [] },
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("requires the environment, route thread, and target thread to match", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});

describe("decideHandoffSend", () => {
  it("lets ordinary prompts fall through to a normal send", () => {
    expect(
      decideHandoffSend({ trimmedPrompt: "fix the retry logic", hasAttachmentsOrContexts: false }),
    ).toEqual({ kind: "not-handoff" });
  });

  it("never falls through for a recognised /handoff (invariant: no turn-start)", () => {
    for (const prompt of ["/handoff", "/handoff out of scope", "  /handoff  x  "]) {
      expect(
        decideHandoffSend({ trimmedPrompt: prompt, hasAttachmentsOrContexts: false }).kind,
      ).not.toBe("not-handoff");
    }
  });

  it("reports the inline empty-explanation error without dispatching", () => {
    expect(
      decideHandoffSend({ trimmedPrompt: "/handoff", hasAttachmentsOrContexts: false }),
    ).toEqual({ kind: "empty-error", message: HANDOFF_EMPTY_EXPLANATION_MESSAGE });
  });

  it("rejects a /handoff carrying attachments or contexts (MVP), never dispatching", () => {
    expect(
      decideHandoffSend({
        trimmedPrompt: "/handoff the retry logic is broken",
        hasAttachmentsOrContexts: true,
      }),
    ).toEqual({ kind: "blocked-context", message: HANDOFF_BLOCKED_CONTEXT_MESSAGE });
  });

  it("dispatches with the parsed explanation when clean", () => {
    expect(
      decideHandoffSend({
        trimmedPrompt: "/handoff the retry logic is broken",
        hasAttachmentsOrContexts: false,
      }),
    ).toEqual({ kind: "dispatch", explanation: "the retry logic is broken" });
  });
});

describe("decideRetroSend", () => {
  it("lets ordinary prompts fall through to a normal send", () => {
    expect(
      decideRetroSend({ trimmedPrompt: "review the process", hasAttachmentsOrContexts: false }),
    ).toEqual({ kind: "not-retro" });
  });

  it("never falls through for a recognised /retro (invariant: no turn-start)", () => {
    for (const prompt of ["/retro", "/retro gate outcomes", "  /retro  x  "]) {
      expect(
        decideRetroSend({ trimmedPrompt: prompt, hasAttachmentsOrContexts: false }).kind,
      ).not.toBe("not-retro");
    }
  });

  it("dispatches a bare /retro with no focus (general review)", () => {
    expect(decideRetroSend({ trimmedPrompt: "/retro", hasAttachmentsOrContexts: false })).toEqual({
      kind: "dispatch",
      focus: undefined,
    });
  });

  it("rejects a /retro carrying attachments or contexts, never dispatching", () => {
    expect(
      decideRetroSend({ trimmedPrompt: "/retro the rework loop", hasAttachmentsOrContexts: true }),
    ).toEqual({ kind: "blocked-context", message: RETRO_BLOCKED_CONTEXT_MESSAGE });
  });

  it("dispatches with the parsed focus when clean", () => {
    expect(
      decideRetroSend({ trimmedPrompt: "/retro the rework loop", hasAttachmentsOrContexts: false }),
    ).toEqual({ kind: "dispatch", focus: "the rework loop" });
  });
});

describe("runComposerDraftIntercept", () => {
  // Minimal stand-in for the composer state `onSend` mutates: a prompt plus the
  // in-flight guard, driven through the same helper ChatView wires up.
  const createHarness = (options: {
    prompt: string;
    dispatch: () => Promise<AtomCommandResult<{ ok: true }, string>>;
  }) => {
    const state = {
      prompt: options.prompt,
      sendInFlight: false,
      dispatches: 0,
      successes: 0,
      failures: 0,
    };
    // Mirrors `onSend`: parse the composer's CURRENT content, bail unless it is
    // still a recognised draft command, then run the shared intercept.
    const submit = async () => {
      if (state.sendInFlight) return "guarded" as const;
      const decision = decideHandoffSend({
        trimmedPrompt: state.prompt.trim(),
        hasAttachmentsOrContexts: false,
      });
      if (decision.kind !== "dispatch") return decision.kind;
      return runComposerDraftIntercept({
        submittedPrompt: state.prompt,
        setSendInFlight: (inFlight) => {
          state.sendInFlight = inFlight;
        },
        clearComposer: () => {
          state.prompt = "";
        },
        readComposerContent: () => ({
          prompt: state.prompt,
          imageCount: 0,
          terminalContextCount: 0,
          elementContextCount: 0,
          previewAnnotationCount: 0,
          reviewCommentCount: 0,
        }),
        restoreComposer: (prompt) => {
          state.prompt = prompt;
        },
        dispatch: () => {
          state.dispatches += 1;
          return options.dispatch();
        },
        onSuccess: () => {
          state.successes += 1;
        },
        onFailure: () => {
          state.failures += 1;
        },
      });
    };
    return { state, submit };
  };

  const succeedAfterLatency = () =>
    new Promise<AtomCommandResult<{ ok: true }, string>>((resolve) => {
      setTimeout(() => resolve(AsyncResult.success({ ok: true } as const)), 5);
    });

  it("dispatches once for a burst of repeated submissions (the double-fire bug)", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: succeedAfterLatency,
    });

    // Eight synchronous presses while the first RPC is still in flight — the
    // shape that previously produced eight drafters and seven duplicate goals.
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => submit()));

    expect(state.dispatches).toBe(1);
    expect(state.successes).toBe(1);
    expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1);
    expect(state.prompt).toBe("");
    expect(state.sendInFlight).toBe(false);
  });

  it("clears the composer before awaiting, so a re-entrant press has nothing to send", async () => {
    let observedPromptDuringDispatch: string | null = null;
    const harness = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: () => {
        observedPromptDuringDispatch = harness.state.prompt;
        return succeedAfterLatency();
      },
    });

    await harness.submit();

    expect(observedPromptDuringDispatch).toBe("");
  });

  it("holds the in-flight guard across the await and releases it on success", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: succeedAfterLatency,
    });

    const pending = submit();
    expect(state.sendInFlight).toBe(true);
    await pending;
    expect(state.sendInFlight).toBe(false);
  });

  it("releases the guard and restores the draft when the RPC fails into an empty composer", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: () =>
        Promise.resolve(AsyncResult.failure<{ ok: true }, string>(Cause.fail("nope"))),
    });

    expect(await submit()).toBe("failure");
    expect(state.failures).toBe(1);
    expect(state.prompt).toBe("/handoff extract the retry logic");
    expect(state.sendInFlight).toBe(false);

    // The restored draft is submittable again — one dispatch per deliberate press.
    expect(state.dispatches).toBe(1);
    expect(await submit()).toBe("failure");
    expect(state.dispatches).toBe(2);
  });

  it("never clobbers text the human typed while the failing RPC was in flight", async () => {
    const harness = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: () => {
        harness.state.prompt = "a thought I had meanwhile";
        return Promise.resolve(AsyncResult.failure<{ ok: true }, string>(Cause.fail("nope")));
      },
    });

    expect(await harness.submit()).toBe("failure");
    expect(harness.state.prompt).toBe("a thought I had meanwhile");
  });

  it("releases the guard even when the dispatch throws", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: () => Promise.reject(new Error("transport exploded")),
    });

    await expect(submit()).rejects.toThrow("transport exploded");
    expect(state.sendInFlight).toBe(false);
  });

  it("is not reached at all while a send is already in flight (caller's entry guard)", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: succeedAfterLatency,
    });
    state.sendInFlight = true;

    expect(await submit()).toBe("guarded");
    expect(state.dispatches).toBe(0);
  });
});

describe("shouldRestoreSubmittedDraft", () => {
  const emptyComposer = {
    prompt: "",
    imageCount: 0,
    terminalContextCount: 0,
    elementContextCount: 0,
    previewAnnotationCount: 0,
    reviewCommentCount: 0,
  };

  it("restores into a completely empty composer", () => {
    expect(shouldRestoreSubmittedDraft(emptyComposer)).toBe(true);
  });

  it("never overwrites any composer content the human added meanwhile", () => {
    const occupied = [
      { prompt: "typed something" },
      { imageCount: 1 },
      { terminalContextCount: 1 },
      { elementContextCount: 1 },
      { previewAnnotationCount: 1 },
      { reviewCommentCount: 1 },
    ];
    for (const overlay of occupied) {
      expect(shouldRestoreSubmittedDraft({ ...emptyComposer, ...overlay })).toBe(false);
    }
  });
});

describe("draft command intercepts: no non-success exit loses the draft", () => {
  // Companion to the no-fall-through invariant above: a recognised /handoff or
  // /retro that does not reach a successful dispatch must leave the typed text
  // recoverable in the composer.
  const runIntercept = async (options: {
    prompt: string;
    hasAttachmentsOrContexts: boolean;
    fail: boolean;
  }) => {
    const state = { prompt: options.prompt, sendInFlight: false };
    const handoff = decideHandoffSend({
      trimmedPrompt: state.prompt.trim(),
      hasAttachmentsOrContexts: options.hasAttachmentsOrContexts,
    });
    const retro = decideRetroSend({
      trimmedPrompt: state.prompt.trim(),
      hasAttachmentsOrContexts: options.hasAttachmentsOrContexts,
    });
    const decision = handoff.kind !== "not-handoff" ? handoff : retro;
    expect(decision.kind).not.toBe("not-handoff");
    expect(decision.kind).not.toBe("not-retro");
    if (decision.kind !== "dispatch") {
      // Inline-error branches return without touching the composer.
      return { outcome: decision.kind, prompt: state.prompt };
    }
    const outcome = await runComposerDraftIntercept({
      submittedPrompt: state.prompt,
      setSendInFlight: (inFlight) => {
        state.sendInFlight = inFlight;
      },
      clearComposer: () => {
        state.prompt = "";
      },
      readComposerContent: () => ({
        prompt: state.prompt,
        imageCount: 0,
        terminalContextCount: 0,
        elementContextCount: 0,
        previewAnnotationCount: 0,
        reviewCommentCount: 0,
      }),
      restoreComposer: (prompt) => {
        state.prompt = prompt;
      },
      dispatch: () =>
        Promise.resolve(
          options.fail
            ? AsyncResult.failure<{ ok: true }, string>(Cause.fail("nope"))
            : AsyncResult.success({ ok: true } as const),
        ),
      onSuccess: () => {},
      onFailure: () => {},
    });
    return { outcome, prompt: state.prompt };
  };

  it("preserves the draft on every non-success exit, for /handoff and /retro alike", async () => {
    const nonSuccessCases = [
      { prompt: "/handoff", hasAttachmentsOrContexts: false, fail: false },
      { prompt: "/handoff extract the retry logic", hasAttachmentsOrContexts: true, fail: false },
      { prompt: "/handoff extract the retry logic", hasAttachmentsOrContexts: false, fail: true },
      { prompt: "/retro gate outcomes", hasAttachmentsOrContexts: true, fail: false },
      { prompt: "/retro gate outcomes", hasAttachmentsOrContexts: false, fail: true },
    ];

    for (const testCase of nonSuccessCases) {
      const result = await runIntercept(testCase);
      expect(result.outcome).not.toBe("success");
      expect(result.prompt).toBe(testCase.prompt);
    }
  });

  it("clears the draft only on a successful dispatch", async () => {
    for (const prompt of ["/handoff extract the retry logic", "/retro gate outcomes"]) {
      const result = await runIntercept({ prompt, hasAttachmentsOrContexts: false, fail: false });
      expect(result.outcome).toBe("success");
      expect(result.prompt).toBe("");
    }
  });

  // The case the two accepted decisions only cover TOGETHER, and the one a
  // reviewer flagged as losing the draft when the receipt is absent: a failure
  // arriving after the human has typed something new. The no-clobber rule
  // deliberately declines to restore (their content wins), so the ONLY thing
  // keeping the submitted text on screen is the receipt. If a future change
  // drops the receipt, or stops recording it before the dispatch, this fails.
  it("keeps the submitted text recoverable via the receipt when the composer is not restored", async () => {
    const submittedPrompt = "/handoff the audit trail misses soft-deleted rows";
    const typedMeanwhile = "a totally unrelated new thought";
    const state = { prompt: submittedPrompt, sendInFlight: false };
    // Stands in for the receipt store: recorded BEFORE the RPC, holding the
    // explanation verbatim, exactly as ChatView.onSend wires it.
    const receipts: Array<{ explanation: string; failure: string | null }> = [];

    const decision = decideHandoffSend({
      trimmedPrompt: state.prompt.trim(),
      hasAttachmentsOrContexts: false,
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") return;
    const receipt = { explanation: decision.explanation, failure: null as string | null };
    receipts.push(receipt);

    const outcome = await runComposerDraftIntercept({
      submittedPrompt,
      setSendInFlight: (inFlight) => {
        state.sendInFlight = inFlight;
      },
      clearComposer: () => {
        state.prompt = "";
        // The human starts a new thought while the RPC is still in flight.
        state.prompt = typedMeanwhile;
      },
      readComposerContent: () => ({
        prompt: state.prompt,
        imageCount: 0,
        terminalContextCount: 0,
        elementContextCount: 0,
        previewAnnotationCount: 0,
        reviewCommentCount: 0,
      }),
      restoreComposer: (prompt) => {
        state.prompt = prompt;
      },
      dispatch: () =>
        Promise.resolve(AsyncResult.failure<{ ok: true }, string>(Cause.fail("rejected"))),
      onSuccess: () => {},
      onFailure: () => {
        receipt.failure = "Source thread is busy.";
      },
    });

    expect(outcome).toBe("failure");
    // Their new content is untouched — never clobbered.
    expect(state.prompt).toBe(typedMeanwhile);
    // ...and the submitted text is still on screen, in full, via the receipt.
    expect(receipts).toEqual([
      {
        explanation: "the audit trail misses soft-deleted rows",
        failure: "Source thread is busy.",
      },
    ]);
  });
});
