/**
 * The PR toolkit on Loom threads (Phase 3 plan seam 13; smoke steps 14 and 15), on
 * the real orchestrator: a PR-watch wake reaches a Loom thread holding
 * `awaiting_acceptance` and the hold survives it (rule 4 clears only on a
 * human-authored or orchestrator turn), and settle-on-merge settles a childless
 * shipper whose outcome is done but never a root with an unfinished sub-thread.
 *
 * Upstream refuses `thread.pull-request.watch` on every `subagent`-lineage thread,
 * which is every Loom child (DL-375): a shipper child cannot start a watch today, so
 * the wake is proven on a Loom root, and the refusal is pinned.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, GoalId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadSettlementService from "../orchestration-v2/ThreadSettlementService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { LoomStoreV2 } from "./projection/LoomStore.ts";
import {
  awaitStoredEvent,
  dispatch,
  LoomOrchestratorTestLayer,
  seedThread,
  spawnChild,
} from "./testkit/loomOrchestratorLayer.ts";

const TestLayer = Layer.mergeAll(
  ThreadSettlementService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ sidebarAutoSettleOnMerge: true }),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: () => Effect.succeed(null),
          invalidateStatus: () => Effect.void,
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          summary: () => Effect.die("no host lookup: the link snapshot is merged"),
          subscribeMerges: Effect.succeed(Stream.empty),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ closeIdle: () => Effect.void }),
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size).fill(1),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      ),
    ),
  ),
).pipe(
  Layer.provideMerge(Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer)),
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

const createdAt = "2026-01-01T00:00:00.000Z";
const pr = (number: number) => ({ host: "github.com", repository: "loom/scratch", number });

/** Links and watches a pull request on a thread, as `watch_pull_request` does. */
const watchPullRequest = (threadId: ThreadId, number: number) =>
  dispatch({
    type: "thread.pull-request.watch",
    commandId: CommandId.make(`pr-watch:${threadId}`),
    threadId,
    ...pr(number),
    watching: true,
    link: { url: `https://github.com/loom/scratch/pull/${number}`, source: "agent" },
  });

const linkPullRequest = (threadId: ThreadId, number: number) =>
  dispatch({
    type: "thread.pull-request.link",
    commandId: CommandId.make(`pr-link:${threadId}`),
    threadId,
    ...pr(number),
    url: `https://github.com/loom/scratch/pull/${number}`,
    source: "agent",
  });

/** A Loom root: the goal gives it a sidecar row, as an emergent or handed-off goal does. */
const seedLoomRoot = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* seedThread({ threadId });
    const goal = yield* (yield* LoomStoreV2).goals.upsert({
      id: GoalId.make(`goal:${threadId}`),
      projectId: ProjectId.make("project:loom-test"),
      slug: threadId,
      title: "Ship the scratch change",
      description: "",
    });
    yield* dispatch({
      type: "thread.goal.set",
      commandId: CommandId.make(`goal-set:${threadId}`),
      threadId,
      createdAt,
      goalId: goal.id,
    });
  });

const raiseAcceptance = (threadId: ThreadId) =>
  dispatch({
    type: "thread.attention.raise",
    commandId: CommandId.make(`pr-raise:${threadId}`),
    threadId,
    createdAt,
    reason: "awaiting_acceptance",
  });

it.layer(TestLayer)("Loom PR toolkit", (it) => {
  it.effect("a PR-watch wake runs on a Loom thread holding awaiting_acceptance; the hold survives", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* LoomStoreV2;
      const root = ThreadId.make("pr-watch-root");
      const child = ThreadId.make("pr-watch-shipper");
      yield* seedLoomRoot(root);
      yield* spawnChild({ parentThreadId: root, threadId: child, role: "shipper" });
      // DL-375: upstream's subagent rule refuses the watch on a Loom child.
      const refused = yield* Effect.flip(watchPullRequest(child, 7));
      assert.include(String((refused as { cause?: unknown }).cause), "is a subagent");

      const shipper = root;
      yield* watchPullRequest(shipper, 7);
      yield* raiseAcceptance(shipper);
      const watch = (yield* orchestrator.getThreadProjection(shipper)).thread.pullRequests?.find(
        (link) => link.number === 7,
      )?.watch;
      assert.isDefined(watch);

      // What PullRequestWatchReactor dispatches when a check fails on the head commit.
      const wakeId = MessageId.make("message:pr-watch-wake:shipper");
      yield* dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-sync:shipper"),
        threadId: shipper,
        ...pr(7),
        startedAt: watch!.startedAt,
        watch: { ...watch!, failedChecks: ["ci"] },
        wake: {
          messageId: wakeId,
          text: "A check failed on the pull request: ci.",
          notification: {
            source: { kind: "monitor" },
            outcome: "failed",
            summary: "Check failed: ci",
          },
        },
      });

      const projection = yield* orchestrator.getThreadProjection(shipper);
      const wake = projection.messages.find((message) => message.id === wakeId);
      assert.equal(wake?.createdBy, "agent");
      assert.isUndefined(wake?.loom?.origin);
      assert.notEqual(wake?.loom?.humanAuthored, true);
      assert.isTrue(projection.runs.some((run) => run.userMessageId === wakeId));
      assert.deepEqual((yield* store.getWorkstream(shipper))!.attention, ["awaiting_acceptance"]);
    }),
  );

  it.effect("settle-on-merge settles a done childless shipper, never a root with a live child", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const root = ThreadId.make("pr-merge-root");
      const shipper = ThreadId.make("pr-merge-shipper");
      const live = ThreadId.make("pr-merge-live");
      yield* seedLoomRoot(root);
      yield* spawnChild({ parentThreadId: root, threadId: shipper, role: "shipper" });
      yield* spawnChild({ parentThreadId: root, threadId: live, graphKey: "live" });
      yield* dispatch({
        type: "thread.outcome.set",
        commandId: CommandId.make("pr-merge-shipper-done"),
        threadId: shipper,
        createdAt,
        outcome: "done",
      });

      // Both the shipper and the root carry the merged pull request.
      const mergedAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 1 }));
      for (const [threadId, number] of [
        [shipper, 11],
        [root, 12],
      ] as const) {
        yield* linkPullRequest(threadId, number);
        yield* dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`pr-merge-sync:${threadId}`),
          threadId,
          ...pr(number),
          snapshot: {
            state: "merged",
            title: "Scratch change",
            headBranch: "scratch",
            baseBranch: "main",
            isDraft: false,
            updatedAt: mergedAt,
            syncedAt: mergedAt,
            mergedAt,
          },
          stack: null,
        });
      }

      const settlement = yield* ThreadSettlementService.ThreadSettlementServiceV2;
      yield* settlement.start();
      yield* awaitStoredEvent({
        afterSequence: 0,
        threadId: shipper,
        predicate: (event) => event.type === "thread.settled",
      });
      yield* settlement.drain;

      const settled = (threadId: ThreadId) =>
        Effect.map(
          orchestrator.getThreadProjection(threadId),
          (projection) => projection.thread.settledAt !== null,
        );
      assert.isTrue(yield* settled(shipper));
      assert.isFalse(yield* settled(root));
      assert.isFalse(yield* settled(live));
    }).pipe(Effect.scoped),
  );
});
