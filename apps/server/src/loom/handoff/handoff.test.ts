/**
 * `/handoff` forks an idle pi source into a drafter root (mid-turn: forked when the turn ends;
 * non-pi: refused). `HandoffDrafterReactor` archives a drafter that recorded a handoff, else raises
 * `needs_guidance` on the source (or the drafter when the source has no Loom row). `/retro` starts
 * a fresh goal-less reviewer whose manifest carries the source's whole tree.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GoalId,
  LOOM_WS_METHODS,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as LoomUsageLedger from "../economics/LoomUsageLedger.ts";
import * as LoomGoalBroadcast from "../projection/LoomGoalBroadcast.ts";
import { UsageLimitSources } from "../../usage/UsageLimitSources.ts";
import { ReviewSnapshotService } from "../review/ReviewSnapshotService.ts";
import { LoomThreadConsult } from "../workstream/consult.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import {
  completeOpenRuns,
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  loomEvent,
  seedRunningRun,
  seedThread,
  spawnChild,
  testModelSelection,
  writeEvents,
} from "../testkit/loomOrchestratorLayer.ts";
import { makeLoomWsHandlers } from "../wsMethods.ts";
import {
  buildDrafterKickoffPrompt,
  buildDrafterTitle,
  HANDOFF_DRAFTER_ROLE,
} from "./handoffDraft.ts";
import {
  classifyHandoffSettlement,
  HANDOFF_HUNG_GRACE_MS,
  HandoffDrafterReactor,
  HandoffDrafterReactorServiceLive,
} from "./HandoffDrafterReactor.ts";
import {
  buildRetroKickoffPrompt,
  buildRetroTitle,
  launchRetro,
  RETRO_SKILL_PATH,
  type RetroManifest,
} from "./retroDraft.ts";
import { RETRO_REVIEWER_ROLE } from "./retroRole.ts";

const pi = ProviderDriverKind.make("pi");
const createdAt = "2026-01-01T00:00:00.000Z";

// The ws handlers also carry 3d's goal methods and seam 11's spend reads (seam 21 integrated).
const TestLayer = Layer.mergeAll(
  HandoffDrafterReactorServiceLive,
  LoomGoalBroadcast.layer,
  LoomUsageLedger.layer,
  Layer.mock(LoomThreadConsult)({}),
  Layer.mock(UsageLimitSources)({}),
  Layer.mock(ReviewSnapshotService)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-retro-" }),
).pipe(Layer.provideMerge(LoomOrchestratorTestLayer), Layer.provideMerge(NodeServices.layer));

/** An idle source whose one turn finished on `driver`; with `goal`, it is a Loom root with a row. */
const seedSource = (name: string, options: { driver?: ProviderDriverKind; goal?: boolean } = {}) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(name);
    yield* seedThread({ threadId });
    if (options.goal) {
      const goal = yield* (yield* LoomStoreV2).goals.upsert({
        id: GoalId.make(`goal:${name}`),
        projectId: ProjectId.make("project:loom-test"),
        slug: name,
        title: "Source goal",
        description: "",
      });
      yield* dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make(`goal-set:${name}`),
        threadId,
        createdAt,
        goalId: goal.id,
      });
    }
    yield* seedRunningRun({ threadId, driver: options.driver ?? pi });
    yield* completeSeededRun({ threadId });
    return threadId;
  });

const handoff = (sourceThreadId: ThreadId, explanation: string) =>
  Effect.flatMap(makeLoomWsHandlers, (handlers) =>
    handlers[LOOM_WS_METHODS.handoffDraft]({ sourceThreadId, explanation }),
  );
const row = (threadId: ThreadId) =>
  Effect.flatMap(LoomStoreV2, (store) => Effect.map(store.getWorkstream(threadId), (r) => r!));
const drafterCount = Effect.flatMap(LoomStoreV2, (store) =>
  Effect.map(
    store.listActiveWorkstreams(),
    (rows) => rows.filter((candidate) => candidate.role === HANDOFF_DRAFTER_ROLE).length,
  ),
);
const settlePass = Effect.flatMap(HandoffDrafterReactor, (reactor) => reactor.runPass);

it("classifyHandoffSettlement counts only this drafter's handoffs and ages a hung kickoff", () => {
  const drafter = ThreadId.make("d");
  const base = {
    threadId: drafter,
    archivedAt: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    handoffDestinations: [],
  };
  const ended = {
    latestRunId: "run-1",
    activityRunStatus: null,
    latestRunStartedAt: null,
    latestRunRequestedAt: null,
  } as never;
  const placed = (by: ThreadId | null) => ({
    ...base,
    handoffDestinations: [
      { goalId: GoalId.make("g"), threadId: ThreadId.make("t"), drafterThreadId: by, createdAt },
    ],
  });
  assert.deepEqual(classifyHandoffSettlement(placed(drafter), ended, 0), {
    kind: "success",
    runId: "run-1",
  });
  assert.deepEqual(classifyHandoffSettlement(placed(null), ended, 0).kind, "success");
  // A copy placed by a later drafter forked from this one is not this drafter's.
  assert.deepEqual(classifyHandoffSettlement(placed(ThreadId.make("other")), ended, 0), {
    kind: "guidance",
    reasonKey: "zero:run-1",
  });
  const running = { ...(ended as object), activityRunStatus: "running" } as never;
  assert.equal(classifyHandoffSettlement(base, running, HANDOFF_HUNG_GRACE_MS).kind, "none");
  assert.deepEqual(classifyHandoffSettlement(base, running, HANDOFF_HUNG_GRACE_MS + 1), {
    kind: "guidance",
    reasonKey: "kickoff-hung",
  });
  assert.equal(
    classifyHandoffSettlement({ ...placed(drafter), archivedAt: createdAt }, ended, 0).kind,
    "none",
  );
});

it.layer(TestLayer)("Loom drafters", (it) => {
  it.effect(
    "/handoff forks an idle pi source into a drafter whose first message is the kickoff",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const source = yield* seedSource("handoff-source", { goal: true });
        const explanation = "the retry logic in FooService is broken";
        const { drafterThreadId } = yield* handoff(source, explanation);

        const drafter = yield* row(drafterThreadId);
        assert.deepInclude(drafter, {
          role: HANDOFF_DRAFTER_ROLE,
          parentThreadId: null,
          forkFromThreadId: source,
          goalId: GoalId.make("goal:handoff-source"),
          held: false,
        });
        const projection = yield* orchestrator.getThreadProjection(drafterThreadId);
        assert.equal(projection.thread.title, buildDrafterTitle(explanation));
        assert.equal(projection.thread.lineage.relationshipToParent, null);
        const [kickoff, ...rest] = projection.messages;
        assert.lengthOf(rest, 0);
        assert.equal(kickoff?.text, buildDrafterKickoffPrompt(explanation));
        assert.include(kickoff?.text ?? "", "mcp__t3-code__goal_handoff");
        assert.equal(kickoff?.loom?.origin, "kickoff");
        assert.isTrue(projection.runs.some((run) => run.userMessageId === kickoff?.id));
        // The session fork: upstream's pending transfer from the source's finished run.
        const { contextTransfers } = yield* orchestrator.getThreadRecords(drafterThreadId, [
          "contextTransfers",
        ]);
        assert.deepInclude(contextTransfers[0], {
          type: "fork",
          sourceThreadId: source,
          targetThreadId: drafterThreadId,
        });
        // The source is untouched.
        assert.lengthOf((yield* orchestrator.getThreadProjection(source)).messages, 1);
      }),
  );

  it.effect("/handoff refuses a non-pi source, creating nothing", () =>
    Effect.gen(function* () {
      const before = yield* drafterCount;
      const codex = yield* seedSource("handoff-codex", {
        driver: ProviderDriverKind.make("codex"),
      });
      const notPi = yield* Effect.flip(handoff(codex, "fix the cache"));
      assert.include(notPi.message, "Only pi-backed");
      assert.equal(yield* drafterCount, before);
    }),
  );

  it.effect("/handoff on a mid-turn source forks once that turn ends", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const source = ThreadId.make("handoff-running");
      yield* seedThread({ threadId: source });
      yield* seedRunningRun({ threadId: source, driver: pi });
      const { drafterThreadId } = yield* handoff(source, "fix the cache");
      const forkOf = Effect.map(
        orchestrator.getThreadRecords(drafterThreadId, ["contextTransfers"]),
        (records) => records.contextTransfers,
      );
      // The drafter exists (the receipt row), but waits: no fork, no kickoff.
      assert.deepInclude(yield* row(drafterThreadId), {
        kickoffAt: null,
        forkFromThreadId: source,
      });
      assert.lengthOf(yield* forkOf, 0);
      yield* settlePass; // still running: still waiting
      assert.lengthOf(yield* forkOf, 0);
      yield* completeSeededRun({ threadId: source });
      yield* settlePass;
      assert.deepInclude((yield* forkOf)[0], { type: "fork", sourceThreadId: source });
      const [kickoff] = (yield* orchestrator.getThreadProjection(drafterThreadId)).messages;
      assert.equal(kickoff?.text, buildDrafterKickoffPrompt("fix the cache"));
      assert.isNotNull((yield* row(drafterThreadId)).kickoffAt);
    }),
  );

  it.effect("/handoff forks a V1-imported source with no V2 run from its bound pi session", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const source = ThreadId.make("handoff-imported");
      yield* seedThread({ threadId: source });
      // What `LoomV1WorkstreamImporter` writes for a thread whose pi session it found.
      const nativeThreadRef = {
        driver: pi,
        nativeId: "/sessions/imported.jsonl",
        strength: "strong",
      } as const;
      yield* writeEvents([
        {
          id: EventId.make("event:import-binding:handoff-imported"),
          type: "provider-thread.updated",
          threadId: source,
          driver: pi,
          providerInstanceId: testModelSelection.instanceId,
          occurredAt: yield* DateTime.now,
          payload: {
            id: ProviderThreadId.make("provider-thread:imported"),
            driver: pi,
            providerInstanceId: testModelSelection.instanceId,
            providerSessionId: null,
            appThreadId: source,
            ownerNodeId: null,
            nativeThreadRef,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: yield* DateTime.now,
            updatedAt: yield* DateTime.now,
          },
        } as never,
      ]);
      const { drafterThreadId } = yield* handoff(source, "split the importer");
      const projection = yield* orchestrator.getThreadProjection(drafterThreadId);
      assert.equal(projection.messages[0]?.text, buildDrafterKickoffPrompt("split the importer"));
      // The kickoff's run starts: upstream resolved the run-less transfer's source.
      assert.isTrue(
        projection.runs.some((run) => run.userMessageId === projection.messages[0]?.id),
      );
      const { contextTransfers } = yield* orchestrator.getThreadRecords(drafterThreadId, [
        "contextTransfers",
      ]);
      assert.deepInclude(contextTransfers[0], { type: "fork", sourceThreadId: source });
      assert.deepEqual(contextTransfers[0]?.sourcePoint, {
        threadId: source,
        providerThreadRef: nativeThreadRef,
      });
    }),
  );

  it.effect(
    "/retro on a mid-turn source starts a fresh goal-less reviewer at once, with the whole tree in its manifest",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const fileSystem = yield* FileSystem.FileSystem;
        const runsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "retro-runs-" });
        const root = ThreadId.make("retro-root");
        const child = ThreadId.make("retro-child");
        const grandchild = ThreadId.make("retro-grandchild");
        yield* seedThread({ threadId: root, title: "Ship the Retro tree!" });
        yield* seedRunningRun({ threadId: root, driver: pi });
        yield* spawnChild({ parentThreadId: root, threadId: child });
        yield* spawnChild({ parentThreadId: child, threadId: grandchild, role: "reviewer" });
        yield* writeEvents([
          yield* loomEvent("thread.attention-raised", child, { reason: "needs_guidance" }),
          yield* loomEvent("thread.outcome-recorded", grandchild, {
            outcome: "needs_rework",
            decision: "loop",
            round: 1,
            counts: { mustFix: 2, niceToHave: 1 },
          }),
        ]);
        const launch = launchRetro({ sourceThreadId: root, focus: "review gates", runsDir });
        const reviewer = yield* launch;

        assert.deepInclude(yield* row(reviewer), {
          role: RETRO_REVIEWER_ROLE,
          parentThreadId: null,
          forkFromThreadId: null,
          goalId: null,
          purpose: `Retro of thread ${root}; focus: review gates`,
        });
        const projection = yield* orchestrator.getThreadProjection(reviewer);
        assert.equal(projection.thread.title, buildRetroTitle("Ship the Retro tree!"));
        const { contextTransfers } = yield* orchestrator.getThreadRecords(reviewer, [
          "contextTransfers",
        ]);
        assert.lengthOf(contextTransfers, 0);

        const [runName] = yield* fileSystem.readDirectory(runsDir);
        assert.match(runName ?? "", /^\d{4}-\d{2}-\d{2}-ship-the-retro-tree$/);
        const runDir = `${runsDir}/${runName}`;
        const manifest = JSON.parse(
          yield* fileSystem.readFileString(`${runDir}/manifest.json`),
        ) as RetroManifest;
        assert.deepInclude(manifest, { version: 1, focus: "review gates", runDir });
        assert.deepEqual(manifest.source, {
          threadId: root,
          rootThreadId: root,
          title: "Ship the Retro tree!",
          goalTitle: null,
        });
        assert.sameMembers(
          manifest.threads.map((thread) => thread.id),
          [root, child, grandchild],
        );
        assert.deepInclude(
          manifest.threads.find((thread) => thread.id === child),
          {
            parentId: root,
            role: "coder",
            attentionEpisodes: 1,
          },
        );
        assert.deepInclude(
          manifest.threads.find((thread) => thread.id === grandchild),
          {
            parentId: child,
            lastDecision: {
              outcome: "needs_rework",
              decision: "loop",
              round: 1,
              counts: { mustFix: 2, niceToHave: 1 },
            },
            reportSynthesised: false,
          },
        );

        // The kickoff is the brief on disk, delivered at once although the source is mid-turn.
        const [kickoff] = projection.messages;
        assert.equal(kickoff?.text, buildRetroKickoffPrompt(manifest, RETRO_SKILL_PATH));
        assert.equal(kickoff?.loom?.origin, "kickoff");
        assert.equal(
          yield* fileSystem.readFileString((yield* row(reviewer)).kickoffBriefPath!),
          kickoff?.text,
        );
        assert.include(kickoff?.text ?? "", runDir);
        assert.include(kickoff?.text ?? "", "skills/retro/SKILL.md");

        // A second retro of the same tree claims the next run directory.
        yield* launch;
        assert.isTrue(yield* fileSystem.exists(`${runDir}-2/manifest.json`));
        // The reactor never touches a reviewer.
        yield* completeOpenRuns(reviewer);
        yield* settlePass;
        assert.deepInclude(yield* row(reviewer), { archivedAt: null, attention: [] });
      }),
  );

  it.effect("the reactor archives a drafter once its handoff is recorded", () =>
    Effect.gen(function* () {
      const source = yield* seedSource("settle-source", { goal: true });
      const { drafterThreadId } = yield* handoff(source, "split the importer");
      yield* settlePass; // the kickoff is still running: nothing
      assert.deepInclude(yield* row(drafterThreadId), { archivedAt: null, outcome: null });
      yield* dispatch({
        type: "thread.handoff.record",
        commandId: CommandId.make("settle-record"),
        threadId: drafterThreadId,
        createdAt,
        drafterThreadId,
        destinationGoalId: GoalId.make("goal:destination"),
        destinationThreadId: ThreadId.make("destination-root"),
      });
      yield* completeOpenRuns(drafterThreadId);
      yield* settlePass;
      const settled = yield* row(drafterThreadId);
      assert.equal(settled.outcome, "done");
      assert.isNotNull(settled.archivedAt);
      assert.deepEqual((yield* row(source)).attention, []);
    }),
  );

  it.effect(
    "a drafter that ends with no handoff flags the source; a hung one with a row-less source flags itself",
    () =>
      Effect.gen(function* () {
        const source = yield* seedSource("zero-source", { goal: true });
        const { drafterThreadId: zero } = yield* handoff(source, "rename the module");
        yield* completeOpenRuns(zero);
        yield* settlePass;
        yield* settlePass;
        assert.deepEqual((yield* row(source)).attention, ["needs_guidance"]);
        assert.deepInclude(yield* row(zero), { archivedAt: null, attention: [] });

        const plain = yield* seedSource("hung-source");
        const { drafterThreadId: hung } = yield* handoff(plain, "audit the logs");
        yield* settlePass;
        assert.deepEqual((yield* row(hung)).attention, []);
        yield* TestClock.adjust(HANDOFF_HUNG_GRACE_MS + 1);
        yield* settlePass;
        assert.deepEqual((yield* row(hung)).attention, ["needs_guidance"]);
        assert.isNull(yield* (yield* LoomStoreV2).getWorkstream(plain));
      }),
  );
});
