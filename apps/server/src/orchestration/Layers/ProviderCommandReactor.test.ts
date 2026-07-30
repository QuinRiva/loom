// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  GoalId,
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderLaunchClaims,
  ProviderLaunchClaimsLive,
} from "../../provider/Services/ProviderLaunchClaims.ts"; // loom:
// loom: the REAL liveness sweep, composed against this harness's services so the
// production claim guard (not a test-local copy of it) is what suppresses recovery.
import {
  DEFAULT_LIVENESS_THRESHOLDS,
  makeWorkstreamLivenessSweepLive,
} from "./WorkstreamLivenessSweep.ts";
import { WorkstreamLivenessSweep } from "../Services/WorkstreamLivenessSweep.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderHealthRegistry } from "../../provider/Services/ProviderHealthRegistry.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { WorktreeProvisioner } from "../../project/WorktreeProvisioner.ts";
import { defaultSessionsRoot, piSessionIdForThread } from "../../provider/piSessionFiles.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | ProviderLaunchClaims, // loom:
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();
  // Post-completion engagement tests create real pi session files under the
  // sessions root (that is what `resolveSessionFilePath` scans); cleaned here.
  const createdSessionDirs = new Set<string>();
  let engagementSessionSeq = 0;
  const makeEngagementSessionDir = (): string => {
    engagementSessionSeq += 1;
    const dir = NodePath.join(
      defaultSessionsRoot(),
      `t3code-engagement-test-${process.pid}-${engagementSessionSeq}`,
    );
    NodeFS.mkdirSync(dir, { recursive: true });
    createdSessionDirs.add(dir);
    return dir;
  };

  afterEach(async () => {
    for (const dir of createdSessionDirs) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
    createdSessionDirs.clear();
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    // Turn-start provisioning guard (item 4). Default is a no-op success stub;
    // isolation tests pass a spy to observe the re-provision-before-turn contract.
    readonly ensureIsolatedChildProvisioned?: (input: {
      readonly threadId: ThreadId;
      readonly role: string;
      readonly branch: string | null;
      readonly worktreePath: string | null;
    }) => Effect.Effect<boolean>;
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
        Effect.tap((startedSession) =>
          Effect.sync(() => {
            runtimeSessions.push(startedSession);
          }),
        ),
      );
    });
    const sendTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() =>
      Effect.succeed({ deliveredContent: true }),
    );
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    // First-turn titling + branch renaming both ride generateStructured (one
    // interpretation round-trip). Default to a confidence-low interpretation so a
    // title is applied but no emergent goal is created unless a test opts in.
    const generateStructured = vi.fn((_: unknown) =>
      Effect.succeed({
        title: "Generated title",
        goal: { title: "Generated goal", description: "Generated goal description" },
        confidence: "low",
      }),
    ) as unknown as TextGenerationShape["generateStructured"] & {
      mockReturnValue: (value: unknown) => void;
      mockImplementation: (impl: (input: unknown) => unknown) => void;
      mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
    };
    const providerSnapshots = [
      {
        instanceId: modelSelection.instanceId,
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getSession: (threadId) =>
        Effect.succeed(runtimeSessions.find((session) => session.threadId === threadId)),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
          emitsExitOnStop: true,
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const ensureIsolatedChildProvisioned = vi.fn(
      input?.ensureIsolatedChildProvisioned ?? (() => Effect.succeed(true)),
    );
    const worktreeProvisionerStub = Layer.succeed(WorktreeProvisioner, {
      provisionWorktree: () => Effect.succeed({ worktreePath: "", branch: "" }),
      provisionIsolatedChild: () => Effect.succeed({ worktreePath: "", branch: "" }),
      ensureIsolatedChildProvisioned,
      hasPendingProvisionFailure: () => false,
      runSetup: () => Effect.void,
    } as never);

    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(worktreeProvisionerStub),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
          generateStructured,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      // loom: in-flight provider-launch claims held across the launch span.
      Layer.provideMerge(ProviderLaunchClaimsLive),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    // loom: the SAME claims instance the reactor holds claims on, so an integrated
    // test can observe the real claim rather than a stand-in.
    const launchClaims = await runtime.runPromise(Effect.service(ProviderLaunchClaims));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        // loom: §4 a fresh auto-titleable root — its placeholder title is still
        // automation-malleable (default), so seed/derived writes may replace it.
        titleProvenance: "default",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      generateStructured,
      ensureIsolatedChildProvisioned,
      runtimeSessions,
      stateDir,
      drain,
      snapshotQuery,
      launchClaims, // loom:
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  // loom: `/retro` fork-reviewer — the retro policy is SERVER-OWNED. The
  // harness project root (/tmp/provider-project) carries no roles/ dir, exactly
  // the cross-project/older-worktree case: the started session must still
  // receive the authorised retro overlay (and compose its own fork identity)
  // rather than falling back to the bare work-model prompt whose worktree rule
  // forbids the reviewer's ~/loom-retro/ deliverable.
  effectIt.effect(
    "injects the server-owned retro overlay for a retro-reviewer fork whose project has no role file",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const now = "2026-01-01T00:00:00.000Z";
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-retro-create"),
          threadId: ThreadId.make("retro-1"),
          projectId: asProjectId("project-1"),
          parentThreadId: null,
          role: "retro-reviewer",
          forkFromThreadId: ThreadId.make("thread-1"),
          title: "Retro: Thread",
          titleProvenance: "curated",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        } as never);

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-retro-turn-1"),
          threadId: ThreadId.make("retro-1"),
          message: {
            messageId: asMessageId("retro-kickoff-1"),
            role: "user",
            text: "You are a retrospective reviewer…",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
        const startInput = harness.startSession.mock.calls[0]?.[1] as {
          readonly appendSystemPrompt?: string;
          readonly forkFromThreadId?: string;
          readonly forkIdentity?: string;
        };
        // The server-owned retro policy is present despite the absent roles/ dir
        // (both write scopes: the in-worktree MDX batch and the central corpus)…
        expect(startInput.appendSystemPrompt).toContain("retrospective reviewer");
        expect(startInput.appendSystemPrompt).toContain("~/loom-retro/");
        expect(startInput.appendSystemPrompt).toContain("mdx-visual-recap");
        // …and the fork composes its own identity instead of replaying the source's.
        expect(startInput.forkFromThreadId).toBe("thread-1");
        expect(startInput.forkIdentity).toBe("compose");
      }),
  );

  // Item 4: the turn-start chokepoint must (re)provision an isolated child whose
  // worktree still points at the PARENT before running its turn, so a
  // `workstream_prompt` on a parked child recovers into its own worktree instead
  // of silently running in the parent's.
  const createIsolatedChild = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    overrides?: { readonly branch?: string | null; readonly worktreePath?: string | null },
  ) => {
    const now = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-child-create"),
        threadId: ThreadId.make("child-iso"),
        projectId: asProjectId("project-1"),
        parentThreadId: ThreadId.make("thread-1"),
        role: "coder",
        purpose: "do the work",
        isolation: "isolated",
        title: "Isolated child",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        // Provisioning failed at promote, so the child still points at the parent.
        branch: overrides?.branch === undefined ? "main" : overrides.branch,
        worktreePath:
          overrides?.worktreePath === undefined ? "/tmp/parent-worktree" : overrides.worktreePath,
        createdAt: now,
      } as never),
    );
  };

  // Route engine dispatches through a helper so test bodies do not call the
  // effect runtime directly (t3code/no-manual-effect-runtime-in-tests permits
  // `Effect.runPromise` inside helpers, which is the pattern the rest of this
  // harness uses).
  const runDispatch = (
    harness: Awaited<ReturnType<typeof createHarness>>,
    command: Parameters<Awaited<ReturnType<typeof createHarness>>["engine"]["dispatch"]>[0],
  ) => Effect.runPromise(harness.engine.dispatch(command));

  const startChildTurn = (harness: Awaited<ReturnType<typeof createHarness>>, id: string) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-child-turn-${id}`),
        threadId: ThreadId.make("child-iso"),
        message: {
          messageId: asMessageId(`child-msg-${id}`),
          role: "user",
          text: "retry provisioning and continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

  it("re-provisions an unprovisioned isolated child before starting its turn", async () => {
    const harness = await createHarness();
    await createIsolatedChild(harness);

    await startChildTurn(harness, "ok");

    await waitFor(() => harness.ensureIsolatedChildProvisioned.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    // Provisioning was asked to (re)build the child's OWN worktree from the
    // parent-pointing meta, and only then did the turn proceed.
    expect(harness.ensureIsolatedChildProvisioned.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("child-iso"),
      role: "coder",
      branch: "main",
      worktreePath: "/tmp/parent-worktree",
    });
  });

  it("does not start the turn (and clears the pending turn-start) when re-provisioning fails", async () => {
    const harness = await createHarness({
      ensureIsolatedChildProvisioned: () => Effect.succeed(false),
    });
    await createIsolatedChild(harness);

    await startChildTurn(harness, "fail");

    await waitFor(() => harness.ensureIsolatedChildProvisioned.mock.calls.length === 1);
    // The pending turn-start row must be cleared so the idle gate stops treating
    // the child as busy (otherwise its re-park never surfaces to the parent).
    await waitFor(
      async () =>
        !(await Effect.runPromise(harness.snapshotQuery.getPendingTurnStartThreadIds())).has(
          ThreadId.make("child-iso"),
        ),
    );
    // The turn must NOT have been sent — the child would otherwise run in the
    // parent's worktree.
    expect(
      harness.sendTurn.mock.calls.some(
        (call) =>
          typeof call[0] === "object" &&
          call[0] !== null &&
          (call[0] as { threadId?: unknown }).threadId === ThreadId.make("child-iso"),
      ),
    ).toBe(false);
  });

  it("skips re-provisioning for an already-provisioned isolated child", async () => {
    const harness = await createHarness();
    // Its own `ws/…-<first8(threadId)>` branch means it is already provisioned.
    await createIsolatedChild(harness, {
      branch: "ws/main/coder-child-is",
      worktreePath: "/tmp/child-worktree",
    });

    await startChildTurn(harness, "provisioned");

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.ensureIsolatedChildProvisioned).not.toHaveBeenCalled();
  });

  it("delivers the never-dispatched kick-off brief on a never-started child's recovery turn", async () => {
    const harness = await createHarness();
    // Parked at promote (branch still points at the parent), so the kick-off turn
    // — and thus the spawn brief — was never dispatched.
    await createIsolatedChild(harness);

    await startChildTurn(harness, "recover");

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const request = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    const input = request?.input ?? "";
    // The recovered first turn carries the kick-off brief (composed via the shared
    // workstreamChildPrompt path) AND the orchestrator's recovery message.
    expect(input).toContain("coder sub-thread");
    expect(input).toContain("do the work");
    expect(input).toContain("retry provisioning and continue");
  });

  it("does not re-deliver the kick-off brief on a prompt to an already-provisioned child", async () => {
    const harness = await createHarness();
    // Already provisioned (its own `ws/…` branch): its kick-off turn already ran,
    // so a later prompt must carry only the orchestrator's message — no brief.
    await createIsolatedChild(harness, {
      branch: "ws/main/coder-child-is",
      worktreePath: "/tmp/child-worktree",
    });

    await startChildTurn(harness, "prompt-again");

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const request = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    const input = request?.input ?? "";
    expect(input).toBe("retry provisioning and continue");
    expect(input).not.toContain("sub-thread");
  });

  // --- Post-completion sub-thread engagement (plan Phase 1) -----------------

  // Create a `done`, fanned-in isolated child that has provably RUN: its pi
  // session file exists on disk (with prior history), its branch is repointed to
  // the parent (as fan-in leaves it), and its worktree is gone. This is exactly
  // the shape a human opens to ask "why is this written this way?".
  const createFannedInDoneChild = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadIdRaw: string,
  ) => {
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make(threadIdRaw);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`cmd-create-${threadIdRaw}`),
        threadId,
        projectId: asProjectId("project-1"),
        parentThreadId: ThreadId.make("thread-1"),
        role: "coder",
        purpose: "do the work",
        isolation: "isolated",
        title: "Fanned-in child",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        // Fan-in repointed the branch/worktree back to the parent's values.
        branch: "main",
        worktreePath: "/tmp/parent-worktree",
        createdAt: now,
      } as never),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fanin.set",
        commandId: CommandId.make(`cmd-fanin-${threadIdRaw}`),
        threadId,
        fanInState: "completed",
        createdAt: now,
      } as never),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`cmd-final-${threadIdRaw}`),
        threadId,
        finalCommitSha: "abc1234deadbeef",
      } as never),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.plan-lane.set",
        commandId: CommandId.make(`cmd-done-${threadIdRaw}`),
        threadId,
        planLane: "done",
        createdAt: now,
      } as never),
    );
    // The durable proof it has run: a real pi session file with prior history.
    const dir = makeEngagementSessionDir();
    NodeFS.writeFileSync(
      NodePath.join(dir, `2026-01-01T00-00-00_${piSessionIdForThread(threadIdRaw)}.jsonl`),
      '{"type":"session-start"}\n{"role":"user","content":"prior context"}\n',
    );
    return threadId;
  };

  const startTerminalChildTurn = (
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId,
    text: string,
  ) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-terminal-turn-${threadId}`),
        threadId,
        message: {
          messageId: asMessageId(`terminal-msg-${threadId}`),
          role: "user",
          text,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

  it("CAPABILITY: a human can converse with a fanned-in child (no reprovision, no brief re-delivery, read-only)", async () => {
    const harness = await createHarness();
    const threadId = await createFannedInDoneChild(harness, "child-done");

    await startTerminalChildTurn(harness, threadId, "why is this written this way?");

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    // NO worktree was (re)provisioned — a thread that has provably run is never
    // re-provisioned, whatever its (repointed) branch name looks like.
    expect(harness.ensureIsolatedChildProvisioned).not.toHaveBeenCalled();
    // NO kickoff brief was re-delivered: the turn carries the human's text only.
    const sent = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sent?.input).toBe("why is this written this way?");
    expect(sent?.input ?? "").not.toContain("sub-thread");
    // The launch is READ-ONLY (Discuss): read-only tools + readOnly flag (which
    // suppresses the workstream MCP session/extension), plus a relocation
    // preamble naming the final commit.
    const startInput = harness.startSession.mock.calls.find(
      (call) => (call[1] as { threadId?: string })?.threadId === threadId,
    )?.[1] as
      | { tools?: ReadonlyArray<string>; readOnly?: boolean; appendSystemPrompt?: string }
      | undefined;
    expect(startInput?.readOnly).toBe(true);
    expect(startInput?.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(startInput?.appendSystemPrompt ?? "").toContain("READ-ONLY");
    expect(startInput?.appendSystemPrompt ?? "").toContain("abc1234deadbeef");
  });

  it("CAPABILITY: a NON-terminal child still gets the full (writable) launch", async () => {
    // Guards the mode split: session-file existence alone must NOT force Discuss;
    // only a terminal lane does. A running child that has a session file resumes
    // with full tools + workstream extension.
    const harness = await createHarness();
    const threadId = ThreadId.make("child-active");
    const now = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-create-child-active"),
        threadId,
        projectId: asProjectId("project-1"),
        parentThreadId: ThreadId.make("thread-1"),
        role: "coder",
        purpose: "do the work",
        isolation: "isolated",
        title: "Active child",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "ws/main/coder-child-ac",
        worktreePath: "/tmp/child-active-worktree",
        createdAt: now,
      } as never),
    );
    // Give it a session file (it has run), but keep it non-terminal (planned).
    const dir = makeEngagementSessionDir();
    NodeFS.writeFileSync(
      NodePath.join(dir, `2026-01-01T00-00-00_${piSessionIdForThread("child-active")}.jsonl`),
      '{"type":"session-start"}\n',
    );

    await startTerminalChildTurn(harness, threadId, "keep going");

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const startInput = harness.startSession.mock.calls.find(
      (call) => (call[1] as { threadId?: string })?.threadId === threadId,
    )?.[1] as { readOnly?: boolean; tools?: ReadonlyArray<string> } | undefined;
    // Not a Discuss launch: no readOnly flag, tools are the role's (not the
    // read-only allowlist).
    expect(startInput?.readOnly).not.toBe(true);
    expect(startInput?.tools ?? []).not.toEqual(["read", "grep", "find", "ls"]);
  });

  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateStructured.mockReturnValue(
      Effect.succeed({
        title: "Generated title",
        goal: { title: "Generated goal", description: "Generated goal description" },
        confidence: "low",
      }),
    );

    // loom: §4 the client no longer writes the first-message title directly — the
    // truncated seed rides on the turn-start `titleSeed`; the server applies it
    // as a `seed`-provenance title, then the LLM upgrades it to `derived`.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateStructured.mock.calls.length === 1);
    const interpretationInput = harness.generateStructured.mock.calls[0]?.[0] as
      | { prompt: string }
      | undefined;
    expect(interpretationInput?.prompt).toContain(
      "Please investigate reconnect failures after restarting the session.",
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  // loom: `/handoff` fork-drafter (finding 4) — a goal-less handoff-drafter root
  // must NOT enter ordinary emergent-goal/title interpretation: doing so would
  // spend a model call and attach an orphan goal that survives the drafter's own
  // archive, violating “only the staged destination remains”.
  it("does not interpret intent/goal for a goal-less handoff-drafter root", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-drafter-create"),
        threadId: ThreadId.make("thread-drafter"),
        projectId: asProjectId("project-1"),
        parentThreadId: null,
        role: "handoff-drafter",
        goalId: null,
        title: "Handoff: fix retry",
        titleProvenance: "curated",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-drafter-turn"),
        threadId: ThreadId.make("thread-drafter"),
        message: {
          messageId: asMessageId("drafter-msg"),
          role: "user",
          text: "draft a handoff for the retry logic",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length >= 1);
    await harness.drain();

    // No interpretation round-trip was issued, and no orphan goal was attached.
    expect(harness.generateStructured.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const drafter = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-drafter"));
    expect(drafter?.goalId).toBeNull();
    expect(readModel.goals.length).toBe(0);
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(() => harness.generateStructured.mock.calls.length === 1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateStructured.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
        goal: { title: "Generated goal", description: "Generated goal description" },
        confidence: "low",
      }),
    );

    // loom: §4 seed rides on turn-start `titleSeed` (see note above).
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateStructured.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("renames the temporary worktree branch off the generated title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateStructured.mockReturnValue(
      Effect.succeed({
        title: "Add a safer reconnect backoff",
        goal: { title: "Generated goal", description: "Generated goal description" },
        confidence: "low",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.renameBranch.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    expect(harness.renameBranch.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project-worktree",
      oldBranch: "t3code/1234abcd",
      newBranch: "t3code/add-a-safer-reconnect-backoff",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  // A thread_fork / goal_continue thread INHERITS a live thread's worktree +
  // branch. Its title is still (re)derived, but the branch rename must be
  // SKIPPED — renaming it would move the branch out from under the source
  // thread (and any children) that share the same worktree.
  effectIt.effect(
    "does not rename an inherited worktree branch shared with another live thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const now = "2026-01-01T00:00:00.000Z";
        const sharedWorktree = "/tmp/shared-fork-worktree";
        const sharedBranch = "t3code/1234abcd";

        // Source thread already occupies the shared worktree + temp branch.
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-source-thread"),
          threadId: ThreadId.make("source-thread"),
          projectId: asProjectId("project-1"),
          title: "Source thread",
          titleProvenance: "curated",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: sharedBranch,
          worktreePath: sharedWorktree,
          createdAt: now,
        });

        // The fork inherits that same worktree + branch (thread-1 stands in).
        yield* harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-fork-branch"),
          threadId: ThreadId.make("thread-1"),
          branch: sharedBranch,
          worktreePath: sharedWorktree,
        });

        harness.generateStructured.mockReturnValue(
          Effect.succeed({
            title: "Add a safer reconnect backoff",
            goal: { title: "Generated goal", description: "Generated goal description" },
            confidence: "low",
          }),
        );

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-fork"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-fork"),
            role: "user",
            text: "Add a safer reconnect backoff.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        // The title is still derived and applied...
        yield* Effect.promise(() =>
          waitFor(() => harness.generateStructured.mock.calls.length === 1),
        );
        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            return (
              readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
              "Add a safer reconnect backoff"
            );
          }),
        );

        // ...but the shared branch is left untouched.
        yield* Effect.promise(() => harness.drain());
        expect(harness.renameBranch).not.toHaveBeenCalled();
        const readModel = yield* Effect.promise(() => harness.readModel());
        expect(
          readModel.threads.find((entry) => entry.id === ThreadId.make("source-thread"))?.branch,
        ).toBe(sharedBranch);
        expect(
          readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.branch,
        ).toBe(sharedBranch);
      }),
  );

  // loom: §4 finding 1 — the REAL bootstrap first-send path stamps the title
  // `seed` server-side; the reactor must then be able to upgrade it to the LLM
  // `derived` title. (thread-1 here stands in for a bootstrap-created thread.)
  effectIt.effect("upgrades a seed-provenance first-message title to the derived LLM title", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const now = "2026-01-01T00:00:00.000Z";
      harness.generateStructured.mockReturnValue(
        Effect.succeed({
          title: "Reconnect backoff redesign",
          goal: { title: "Generated goal", description: "Generated goal description" },
          confidence: "low",
        }),
      );

      // Simulate what ws.ts now does at bootstrap create: a first-message title
      // stamped `seed` (not curated).
      yield* harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-seed-title"),
        threadId: ThreadId.make("thread-1"),
        title: "Please redesign the reconnect backoff so it...",
        titleProvenance: "seed",
      });

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-seed-derived"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-seed-derived"),
          role: "user",
          text: "Please redesign the reconnect backoff so it is safer.",
          attachments: [],
        },
        titleSeed: "Please redesign the reconnect backoff so it...",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(() => harness.generateStructured.mock.calls.length === 1),
      );
      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
            "Reconnect backoff redesign"
          );
        }),
      );
    }),
  );

  // loom: §1 finding — Bug A lockdown: a goal-less workstream child kick-off must
  // NEVER interpret intent (no text generation) and must NEVER create a goal.
  effectIt.effect(
    "does not interpret intent or create a goal for a goal-less workstream child",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const now = "2026-01-01T00:00:00.000Z";
        harness.generateStructured.mockReturnValue(
          Effect.succeed({
            title: "Should never be used",
            goal: { title: "Should never be created", description: "" },
            confidence: "high",
          }),
        );

        // A child under thread-1, goal-less (the exact Bug A shape).
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-create-child"),
          threadId: ThreadId.make("thread-child"),
          projectId: asProjectId("project-1"),
          parentThreadId: ThreadId.make("thread-1"),
          goalId: null,
          role: "coder",
          title: "Child worker",
          titleProvenance: "curated",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-child"),
          threadId: ThreadId.make("thread-child"),
          message: {
            messageId: asMessageId("user-message-child"),
            role: "user",
            text: "Merge coder changes and open the PR.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
        // The child ran its turn but never interpreted intent …
        expect(harness.generateStructured).not.toHaveBeenCalled();
        // … and no goal was created.
        const readModel = yield* Effect.promise(() => harness.readModel());
        expect(readModel.goals).toHaveLength(0);
        expect(
          readModel.threads.find((entry) => entry.id === ThreadId.make("thread-child"))?.goalId,
        ).toBeNull();
      }),
  );

  // loom: §4 finding 3 — a goal-attached root whose title is still `seed` must be
  // able to reach `derived` (title applied) WITHOUT creating a second goal.
  effectIt.effect(
    "upgrades a goal-attached root's seed title to derived without creating a goal",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const now = "2026-01-01T00:00:00.000Z";
        harness.generateStructured.mockReturnValue(
          Effect.succeed({
            title: "Refined subject line",
            goal: { title: "Should not be created", description: "" },
            confidence: "high",
          }),
        );

        yield* harness.engine.dispatch({
          type: "goal.create",
          commandId: CommandId.make("cmd-existing-goal"),
          goalId: GoalId.make("goal-existing"),
          projectId: asProjectId("project-1"),
          slug: "existing-goal",
          title: "Existing Goal",
          createdAt: now,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-create-goal-root"),
          threadId: ThreadId.make("thread-goal-root"),
          projectId: asProjectId("project-1"),
          parentThreadId: null,
          goalId: GoalId.make("goal-existing"),
          title: "raw first message seed for a goal-attached root...",
          titleProvenance: "seed",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-goal-root"),
          threadId: ThreadId.make("thread-goal-root"),
          message: {
            messageId: asMessageId("user-message-goal-root"),
            role: "user",
            text: "raw first message seed for a goal-attached root, expanded.",
            attachments: [],
          },
          titleSeed: "raw first message seed for a goal-attached root...",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(() => harness.generateStructured.mock.calls.length === 1),
        );
        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            return (
              readModel.threads.find((entry) => entry.id === ThreadId.make("thread-goal-root"))
                ?.title === "Refined subject line"
            );
          }),
        );
        // The derived title was applied, but no SECOND goal was created.
        const readModel = yield* Effect.promise(() => harness.readModel());
        expect(readModel.goals).toHaveLength(1);
      }),
  );

  // loom: §4 finding 2 — the exact Bug B failure mode. A goal-less root whose
  // turn-2 message is a mid-conversation INSTRUCTION must force its goal from the
  // OPENING context (first message + its attachments), never the triggering
  // message. This inspects the second interpretation prompt directly.
  effectIt.effect(
    "forces the turn-2 goal from opening context, excluding the triggering message",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const now = "2026-01-01T00:00:00.000Z";
        // Turn 1 (low confidence): applies a derived title, creates NO goal.
        // Turn 2+ (high confidence): forces the goal.
        let interpretationCall = 0;
        harness.generateStructured.mockImplementation(() => {
          interpretationCall += 1;
          return Effect.succeed(
            interpretationCall === 1
              ? {
                  title: "Reconnect resume investigation",
                  goal: { title: "placeholder", description: "placeholder" },
                  confidence: "low",
                }
              : {
                  title: "should not be applied on turn 2",
                  goal: { title: "Reconnect resume", description: "Fix the resume spinner" },
                  confidence: "high",
                },
          );
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-open-turn1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-open-1"),
            role: "user",
            text: "Investigate why the session drops its reconnect on resume.",
            attachments: [
              {
                type: "image",
                id: "att-opening",
                name: "opening-diagram.png",
                mimeType: "image/png",
                sizeBytes: 1024,
              },
            ],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        // Let turn-1 interpretation finish (title applied → in-flight lock freed)
        // before triggering turn 2, so turn 2's interpretation is not deduped.
        yield* Effect.promise(() =>
          waitFor(() => harness.generateStructured.mock.calls.length === 1),
        );
        yield* Effect.promise(() =>
          waitFor(async () => {
            const rm = await harness.readModel();
            return (
              rm.threads.find((t) => t.id === ThreadId.make("thread-1"))?.title ===
              "Reconnect resume investigation"
            );
          }),
        );

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-open-turn2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-trigger-2"),
            role: "user",
            text: "Merge coder changes and open the PR.",
            attachments: [
              {
                type: "image",
                id: "att-trigger",
                name: "pr-screenshot.png",
                mimeType: "image/png",
                sizeBytes: 2048,
              },
            ],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        // Turn 2 forces goal creation → interpretation runs a second time.
        yield* Effect.promise(() =>
          waitFor(() => harness.generateStructured.mock.calls.length === 2),
        );
        yield* Effect.promise(() =>
          waitFor(async () => {
            const rm = await harness.readModel();
            return rm.goals.length === 1;
          }),
        );

        const turn2Prompt =
          (harness.generateStructured.mock.calls[1]?.[0] as { prompt: string } | undefined)
            ?.prompt ?? "";
        // Opening objective + its attachment are the interpretation input …
        expect(turn2Prompt).toContain("Investigate why the session drops its reconnect on resume.");
        expect(turn2Prompt).toContain("opening-diagram.png");
        // … the triggering instruction + its attachment are excluded.
        expect(turn2Prompt).not.toContain("Merge coder changes");
        expect(turn2Prompt).not.toContain("pr-screenshot.png");

        // The forced goal was created from the opening objective.
        const readModel = yield* Effect.promise(() => harness.readModel());
        expect(readModel.goals).toHaveLength(1);
        expect(readModel.goals[0]?.title).toBe("Reconnect resume");
      }),
  );

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              "cannot switch models after the conversation has started",
            ),
          },
        });
      }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  // Settle-FIRST: the durable `user-input.resolved` lands in the same transaction
  // as the delivery intent, so the question is over the moment the command is
  // accepted and provider delivery is best-effort afterwards.
  it("settles the durable record before forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-for-user-input"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            queuedMessages: { steering: [], followUp: [] },
            updatedAt: now,
          },
          createdAt: now,
        })
        .pipe(
          Effect.andThen(
            harness.engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make("cmd-user-input-requested-happy"),
              threadId: ThreadId.make("thread-1"),
              activity: {
                id: EventId.make("activity-user-input-requested-happy"),
                tone: "info",
                kind: "user-input.requested",
                summary: "User input requested",
                payload: { requestId: "user-input-request-1", questions: [] },
                turnId: null,
                createdAt: now,
              },
              createdAt: now,
            }),
          ),
          Effect.andThen(
            harness.engine.dispatch({
              type: "thread.user-input.respond",
              commandId: CommandId.make("cmd-user-input-respond"),
              threadId: ThreadId.make("thread-1"),
              requestId: asApprovalRequestId("user-input-request-1"),
              answers: {
                sandbox_mode: "workspace-write",
              },
              createdAt: now,
            }),
          ),
        ),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
      outcome: "answered",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const resolved = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolved?.payload).toMatchObject({ outcome: "answered" });
  });

  // EXACTLY-ONCE, durably. The fallback turn's command id is derived from the
  // causative settlement event, so a redelivery/replay of that same event is
  // receipt-deduped by the engine instead of opening a second turn and delivering
  // an action-bearing human message twice.
  it("opens exactly one fallback turn when the settlement event is redelivered", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.succeed({ deliveredContent: false }),
    );

    await harness.engine
      .dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-replay"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: asTurnId("turn-blocked-replay"),
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      })
      .pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("cmd-question-open-for-replay"),
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-question-open-for-replay"),
              tone: "info",
              kind: "user-input.requested",
              summary: "User input requested",
              payload: { requestId: "user-input-request-replay", questions: [] },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        ),
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-plain-message-replay"),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: MessageId.make("message-replay"),
              role: "user",
              text: "ship it",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: now,
          }),
        ),
        Effect.runPromise,
      );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    const fallbackMessages = async () => {
      const model = await harness.readModel();
      return (
        model.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.messages ?? []
      ).filter(
        (message) => message.origin === "control_notice" && message.text.includes("ship it"),
      );
    };
    expect(await fallbackMessages()).toHaveLength(1);

    // The settlement event that caused it, and the command id the reactor derives
    // from it. Re-dispatching that exact id is what a reactor retry or an event
    // redelivery produces; the engine's command receipt must make it a no-op.
    // With the previous random id this opened a second turn and delivered the
    // human's message twice.
    const events = Array.from(
      await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0))),
    );
    const settlement = events.find(
      (event) =>
        event.type === "thread.user-input-response-requested" &&
        (event.payload as { requestId?: string }).requestId === "user-input-request-replay",
    );
    expect(settlement).toBeDefined();
    const sendTurnsBefore = harness.sendTurn.mock.calls.length;

    await Effect.runPromise(
      harness.engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(
            `server:user-input-late-delivery:user-input-request-replay:${settlement?.eventId}`,
          ),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-replay-duplicate"),
            role: "user",
            origin: "control_notice",
            text: "ship it (a duplicate that must never land)",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: now,
        })
        .pipe(Effect.ignoreCause({ log: false })),
    );
    await harness.drain();

    // Still exactly one delivery, and no duplicate ever reached the provider.
    expect(await fallbackMessages()).toHaveLength(1);
    expect(harness.sendTurn.mock.calls.length).toBe(sendTurnsBefore);
    const after = await harness.readModel();
    expect(
      (after.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.messages ?? []).some(
        (message) => message.text.includes("must never land"),
      ),
    ).toBe(false);
  });

  // RELEASE-BEFORE-TURN, end to end. This is the ordering the SDK/ACP fallback
  // depends on: when a provider's question callback cannot carry the supersede
  // message, the reactor opens exactly one new turn instead — but that turn must
  // not be dispatched while the provider is still inside the callback, or it is
  // folded into the live turn as a steer and swallowed (the very loss this gate
  // exists to prevent). The mock below models a provider that is still blocked
  // until it says otherwise, and asserts no `sendTurn` happens before it does.
  it("never dispatches the fallback turn while the provider is still in the callback", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    let callbackReleased = false;
    let sendTurnWhileBlocked = false;

    harness.sendTurn.mockImplementation(() => {
      if (!callbackReleased) sendTurnWhileBlocked = true;
      return Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-fallback"),
      });
    });
    // A provider whose callback stays blocked for a while, then releases and
    // reports that the outcome's content could not ride it.
    harness.respondToUserInput.mockImplementation(() =>
      Effect.sleep("50 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            callbackReleased = true;
            return { deliveredContent: false };
          }),
        ),
      ),
    );

    await harness.engine
      .dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-release-order"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: asTurnId("turn-blocked-in-callback"),
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      })
      .pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("cmd-question-open-for-release-order"),
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-question-open-for-release-order"),
              tone: "info",
              kind: "user-input.requested",
              summary: "User input requested",
              payload: { requestId: "user-input-request-release-order", questions: [] },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        ),
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-plain-message-release-order"),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: MessageId.make("message-release-order"),
              role: "user",
              text: "delete the staging bucket",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: now,
          }),
        ),
        Effect.runPromise,
      );

    // Exactly one fallback turn, and it happened only after the release.
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    expect(sendTurnWhileBlocked).toBe(false);
    expect(harness.sendTurn.mock.calls).toHaveLength(1);

    // …and it carries the human's ACTUAL message, not just a generic notice.
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.messages.some(
        (message) =>
          message.origin === "control_notice" &&
          message.text.includes("delete the staging bucket") &&
          message.text.includes("user-input-request-release-order"),
      ),
    ).toBe(true);
  });

  // Finding: a stop/interrupt against an ALREADY-INACTIVE provider used to clear
  // nothing, because the runtime cancel paths only fire when the adapter is
  // reachable. That reproduced incident 1's stale shape from a deliberate human
  // action — and would have left the reachable Stop control unable to unwedge the
  // very state it looks like it should fix.
  it("settles open questions on stop and interrupt even with no live provider", async () => {
    for (const [index, scenario] of (
      [
        { command: "thread.session.stop", requestId: "user-input-open-at-stop" },
        { command: "thread.turn.interrupt", requestId: "user-input-open-at-interrupt" },
      ] as const
    ).entries()) {
      const harness = await createHarness();
      const now = "2026-01-01T00:00:00.000Z";

      await harness.engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`cmd-question-open-before-${index}`),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make(`activity-question-open-before-${index}`),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: { requestId: scenario.requestId, questions: [] },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        })
        .pipe(
          // No session is ever set: the provider is gone, which is precisely the
          // case the old code skipped.
          Effect.andThen(
            harness.engine.dispatch({
              type: scenario.command,
              commandId: CommandId.make(`cmd-${scenario.command}-${index}`),
              threadId: ThreadId.make("thread-1"),
              createdAt: now,
            }),
          ),
          Effect.runPromise,
        );

      await waitFor(async () => {
        const readModel = await harness.readModel();
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        return (
          thread?.activities.some(
            (activity) =>
              activity.kind === "user-input.resolved" &&
              (activity.payload as Record<string, unknown>).requestId === scenario.requestId,
          ) ?? false
        );
      });

      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      const resolved = thread?.activities.find(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          (activity.payload as Record<string, unknown>).requestId === scenario.requestId,
      );
      expect(resolved?.payload).toMatchObject({ outcome: "cancelled" });
    }
  });

  // Incident 2, end to end through decider → reactor → adapter. A plain human
  // message while a question is open must reach the model EXACTLY ONCE: as the
  // tool result. If a turn-start also fired, pi would fold the same text into the
  // live turn as a steer and an action-bearing reply would execute twice.
  it("supersedes without any sendTurn on the live path", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.engine
      .dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-supersede"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "pi",
          runtimeMode: "full-access",
          activeTurnId: asTurnId("turn-blocked-on-question"),
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      })
      .pipe(
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("cmd-question-open-for-supersede"),
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-question-open-for-supersede"),
              tone: "info",
              kind: "user-input.requested",
              summary: "User input requested",
              payload: { requestId: "user-input-request-supersede", questions: [] },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        ),
        Effect.andThen(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-plain-message-while-question-open"),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: MessageId.make("message-supersede"),
              role: "user",
              text: "delete the staging bucket",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: now,
          }),
        ),
      )
      .pipe(Effect.runPromise);

    // The outcome is delivered to the waiting tool call, carrying the text.
    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toMatchObject({
      threadId: "thread-1",
      requestId: "user-input-request-supersede",
      outcome: "superseded",
      message: "delete the staging bucket",
    });

    // And the adapter is never asked to send a turn: no second copy of the
    // instruction, as a steer or otherwise. `drain` is the deterministic wait —
    // the reactor's queue is empty, so a turn-start would already have landed.
    await harness.drain();
    expect(harness.sendTurn.mock.calls).toHaveLength(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const resolved = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-supersede",
    );
    expect(resolved?.payload).toMatchObject({ outcome: "superseded" });
    // The human's message is still in the transcript.
    expect(thread?.messages.some((message) => message.text === "delete the staging bucket")).toBe(
      true,
    );
  });

  // Dismiss settles unconditionally, with no provider round-trip on the critical
  // path — the escape hatch that works even when the asking process is dead.
  it("settles a question on dismiss without any provider round-trip", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-user-input-requested-dismiss"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-user-input-requested-dismiss"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: { requestId: "user-input-request-dismiss", questions: [] },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        })
        .pipe(
          Effect.andThen(
            harness.engine.dispatch({
              type: "thread.user-input.dismiss",
              commandId: CommandId.make("cmd-user-input-dismiss"),
              threadId: ThreadId.make("thread-1"),
              requestId: asApprovalRequestId("user-input-request-dismiss"),
              createdAt: now,
            }),
          ),
        ),
    );

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const resolved = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-dismiss",
    );
    expect(resolved?.payload).toMatchObject({ outcome: "dismissed" });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  // A delivery failure can no longer leave the question open: the record was
  // already settled, and the outcome is delivered as a NEW TURN instead of being
  // lost. This is incident 1's shape — the provider callback is gone, so sixteen
  // answer attempts used to change nothing.
  it("converts an undeliverable answer into a new turn, with the record already settled", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await runDispatch(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-for-user-input-error"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        queuedMessages: { steering: [], followUp: [] },
        updatedAt: now,
      },
      createdAt: now,
    });

    await runDispatch(harness, {
      type: "thread.activity.append",
      commandId: CommandId.make("cmd-user-input-requested"),
      threadId: ThreadId.make("thread-1"),
      activity: {
        id: EventId.make("activity-user-input-requested"),
        tone: "info",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: {
          requestId: "user-input-request-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });

    await runDispatch(harness, {
      type: "thread.user-input.respond",
      commandId: CommandId.make("cmd-user-input-respond-stale"),
      threadId: ThreadId.make("thread-1"),
      requestId: asApprovalRequestId("user-input-request-1"),
      answers: {
        sandbox_mode: "workspace-write",
      },
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({ requestId: "user-input-request-1" });

    // The question IS settled, despite the delivery failure.
    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity?.payload).toMatchObject({ outcome: "answered" });

    // …and the answer is not lost: it opens the next turn, tagged to the request.
    await waitFor(async () => {
      const latest = await harness.readModel();
      const latestThread = latest.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        latestThread?.messages.some(
          (message) => message.role === "user" && message.text.includes("user-input-request-1"),
        ) ?? false
      );
    });
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await runDispatch(harness, {
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-for-stop"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        queuedMessages: { steering: [], followUp: [] },
        updatedAt: now,
      },
      createdAt: now,
    });

    await runDispatch(harness, {
      type: "thread.session.stop",
      commandId: CommandId.make("cmd-session-stop"),
      threadId: ThreadId.make("thread-1"),
      createdAt: now,
    });

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  // ─── Integrated regression guard: claim span vs. stuck-launch recovery ──────
  // The pieces are unit-tested elsewhere (claim semantics in isolation; sweep
  // behaviour given a claim). This test wires the REAL reactor to the REAL recovery
  // path and blocks the original `startSession` on a Deferred, reproducing the
  // round-3 race end to end: while that launch is unresolved the reactor has
  // already written `session.starting` + the user message and writes nothing
  // further, so every durable signal reads "wedged" and both CAS tokens match.
  //
  // The assertion that matters is the SEND COUNT: exactly one provider send, ever.
  // If a future refactor shrinks the claim span (moves it inside `startSession`, or
  // drops it from the turn-start path), recovery fires into that window and this
  // becomes 2 — verified by mutation, not assumed.
  effectIt.effect(
    "does not double-send when a stuck-launch recovery races an in-flight startSession",
    () =>
      Effect.gen(function* () {
        const releaseLaunch = yield* Deferred.make<void>();
        const launchStarted = yield* Deferred.make<void>();
        const harness = yield* Effect.promise(() =>
          createHarness({
            // Model a slow provider launch: process spawn / pi fork / MCP handshake.
            startSessionEffect: (session) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(launchStarted, undefined);
                yield* Deferred.await(releaseLaunch);
                return session;
              }),
          }),
        );
        const now = "2026-01-01T00:00:00.000Z";
        // A SUB-thread: the liveness sweep only judges threads with a parent, so a
        // root would be skipped before the claim check is ever reached and the test
        // would pass for the wrong reason.
        const THREAD = ThreadId.make("child-in-flight");
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-create-child-in-flight"),
          threadId: THREAD,
          projectId: asProjectId("project-1"),
          parentThreadId: ThreadId.make("thread-1"),
          role: "coder",
          purpose: "exercise the in-flight launch window",
          planLane: "in_progress",
          title: "Child in flight",
          titleProvenance: "curated",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        } as never);

        // The genuine turn-start. It will park inside startSession.
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-in-flight"),
          threadId: THREAD,
          message: {
            messageId: asMessageId("user-message-in-flight"),
            role: "user",
            text: "the original prompt",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        // Wait until the launch is genuinely on the stack and unresolved.
        yield* Deferred.await(launchStarted);
        yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));

        // Preconditions: exactly the shape the recovery judges to be a wedge.
        const wedged = yield* Effect.promise(() => harness.readModel());
        const thread = wedged.threads.find((entry) => entry.id === THREAD);
        expect(thread?.session?.status).toBe("starting");
        expect(thread?.session?.activeTurnId).toBeNull();
        // ...and nothing sent yet, so a double-send would be observable.
        expect(harness.sendTurn).not.toHaveBeenCalled();

        // The ONE signal that separates mid-launch from wedged, read off the SAME
        // claims instance the reactor holds — that wiring is what is under test.
        expect(yield* harness.launchClaims.isClaimed(THREAD)).toBe(true);

        // Drive a REAL WorkstreamLivenessSweep pass, composed against the harness's
        // actual engine / projection / claims instances. Deliberately NOT a
        // test-local reimplementation of the guard: the production sweep's own
        // claim check must be the thing that suppresses recovery here, so deleting
        // it makes this test fail.
        //
        // Everything else is arranged to make the sweep WANT to recover: the thread
        // is a sub-thread past the stuck-launch grace with no adapter session and no
        // runtime binding. Only the held claim stands in the way.
        // Count completed sweep passes by observing the snapshot read each pass
        // begins with, so the test waits on a real signal instead of a sleep.
        let sweepPassCount = 0;
        const sweepPasses = () => sweepPassCount;
        const countingSnapshotQuery = {
          ...harness.snapshotQuery,
          getShellSnapshot: () =>
            harness.snapshotQuery.getShellSnapshot().pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  sweepPassCount += 1;
                }),
              ),
            ),
        } as unknown as ProjectionSnapshotQuery["Service"];

        const sweepDeps = Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, harness.engine),
          Layer.succeed(ProjectionSnapshotQuery, countingSnapshotQuery),
          Layer.succeed(ProviderLaunchClaims, harness.launchClaims),
          Layer.succeed(ProviderSessionDirectory, {
            // No binding yet — `bindSessionToThread` only runs once startSession
            // resolves, which is precisely the window under test.
            listBindings: () => Effect.succeed([]),
          } as unknown as ProviderSessionDirectory["Service"]),
          Layer.succeed(ProviderService, {
            // No adapter-reported session either.
            listSessions: () => Effect.succeed([]),
          } as unknown as ProviderService["Service"]),
          Layer.succeed(ProviderHealthRegistry, {
            isExhausted: () => Effect.succeed(false),
            exhaustedUntil: () => Effect.succeed(null),
            markExhausted: () => Effect.void,
            snapshot: Effect.succeed([]),
            streamChanges: Stream.empty,
          } as unknown as ProviderHealthRegistry["Service"]),
          Layer.succeed(ServerSettingsService, {
            getSettings: Effect.succeed({ providerInstances: [] }),
          } as unknown as ServerSettingsService["Service"]),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-reactor-sweep-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer));

        // A zero grace window makes the wedge immediately "old enough", so the pass
        // reaches its liveness decision without any clock manipulation (this suite
        // runs on the real clock).
        const sweepLayer = makeWorkstreamLivenessSweepLive({
          ...DEFAULT_LIVENESS_THRESHOLDS,
          stuckLaunchGraceMs: 0,
        }).pipe(Layer.provide(sweepDeps));

        yield* Effect.scoped(
          Effect.gen(function* () {
            const sweep = yield* WorkstreamLivenessSweep;
            yield* sweep.start();
            // Let the forked sweep fibre run its first pass to completion.
            yield* Effect.promise(() => waitFor(() => sweepPasses() >= 1));
          }).pipe(Effect.provide(sweepLayer)),
        );

        // Let the original launch finish and settle.
        yield* Deferred.succeed(releaseLaunch, undefined);
        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length >= 1));
        yield* Effect.promise(() => harness.drain());

        // THE guard: one launch, one send — the original prompt and nothing else.
        expect(harness.startSession.mock.calls.length).toBe(1);
        expect(harness.sendTurn.mock.calls.length).toBe(1);
        // The claim is released, so a genuine later wedge stays recoverable.
        expect(yield* harness.launchClaims.isClaimed(THREAD)).toBe(false);
      }),
  );
});
