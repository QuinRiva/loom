/**
 * thread.spawn / thread.scaffold on the real engine (plan §2, D5–D7, DL-223):
 * the parent is the lock, a row-less parent gains its sidecar, graph keys are
 * unique per parent across archived and deleted children, cycles are refused
 * all-or-nothing, and the child's V2 row is an explicit field list.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, type OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { LoomStoreV2 } from "../loom/projection/LoomStore.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  seedThread,
  spawnChild,
  testModelSelection,
} from "../loom/testkit/loomOrchestratorLayer.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";

const causeOf = (error: { readonly _tag: string }) =>
  error._tag === "OrchestratorDispatchError"
    ? String((error as { cause?: unknown }).cause)
    : error._tag;

it.layer(LoomOrchestratorTestLayer)("Loom spawn and scaffold", (it) => {
  it.effect("spawn locks the parent, creates its sidecar, and writes an explicit child row", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* LoomStoreV2;
      const receipts = yield* CommandReceiptStoreV2;
      const parent = ThreadId.make("spawn-parent");
      const child = ThreadId.make("spawn-child");
      yield* seedThread({ threadId: parent });
      assert.isNull(yield* store.getWorkstream(parent));

      const result = yield* spawnChild({
        parentThreadId: parent,
        threadId: child,
        graphKey: "coder",
      });
      const receipt = Option.getOrThrow(
        yield* receipts.getByCommandId(CommandId.make(`server:test-spawn:${child}`)),
      );
      assert.equal(receipt.threadId, parent);
      assert.deepEqual(
        result.storedEvents.map((stored) => [stored.event.type, stored.event.threadId]),
        [
          ["thread.workstream-created", parent],
          ["thread.created", child],
          ["thread.workstream-created", child],
        ],
      );
      const created = result.storedEvents.find((stored) => stored.event.type === "thread.created")!
        .event.payload as OrchestrationV2AppThread;
      assert.deepEqual(Object.keys(created).toSorted(), [
        "activeProviderThreadId",
        "archivedAt",
        "branch",
        "createdAt",
        "createdBy",
        "creationSource",
        "deletedAt",
        "forkedFrom",
        "id",
        "interactionMode",
        "lastVisitedAt",
        "lineage",
        "modelSelection",
        "projectId",
        "providerInstanceId",
        "runtimeMode",
        "settledAt",
        "settledOverride",
        "snoozedAt",
        "snoozedUntil",
        "title",
        "updatedAt",
        "worktreePath",
      ]);
      assert.isNull(created.forkedFrom);
      assert.deepEqual(created.lineage, {
        parentThreadId: parent,
        relationshipToParent: "subagent",
        rootThreadId: parent,
      });
      assert.equal(created.creationSource, "mcp");
      assert.deepEqual(created.modelSelection, testModelSelection);

      assert.deepInclude(yield* store.getWorkstream(parent), {
        parentThreadId: null,
        rootThreadId: parent,
        held: false,
      });
      assert.deepInclude(yield* store.getWorkstream(child), {
        parentThreadId: parent,
        rootThreadId: parent,
        graphKey: "coder",
      });
      assert.equal((yield* orchestrator.getThreadShell(child))?.lineage.parentThreadId, parent);

      // A grandchild names the same root.
      const grandchild = ThreadId.make("spawn-grandchild");
      yield* spawnChild({ parentThreadId: child, threadId: grandchild });
      assert.equal((yield* store.getWorkstream(grandchild))?.rootThreadId, parent);
    }),
  );

  it.effect(
    "graph keys are unique per parent, including deleted children; concurrent spawns serialise",
    () =>
      Effect.gen(function* () {
        const parent = ThreadId.make("keys-parent");
        yield* seedThread({ threadId: parent });
        yield* spawnChild({
          parentThreadId: parent,
          threadId: ThreadId.make("keys-a"),
          graphKey: "a",
        });
        const duplicate = yield* Effect.flip(
          spawnChild({ parentThreadId: parent, threadId: ThreadId.make("keys-a2"), graphKey: "a" }),
        );
        assert.include(causeOf(duplicate), "already used");

        const gone = ThreadId.make("keys-gone");
        yield* spawnChild({ parentThreadId: parent, threadId: gone, graphKey: "gone" });
        yield* dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-gone"),
          threadId: gone,
        });
        assert.isNotNull(
          (yield* (yield* LoomStoreV2).listChildren(parent, { includeDeleted: true })).find(
            (row) => row.threadId === gone && row.deletedAt !== null,
          ),
        );
        const reused = yield* Effect.flip(
          spawnChild({
            parentThreadId: parent,
            threadId: ThreadId.make("keys-gone2"),
            graphKey: "gone",
          }),
        );
        assert.include(causeOf(reused), "already used");

        // Under the parent lock the loser is refused by validation, not by a failed commit.
        const raced = yield* Effect.all(
          ["keys-race-1", "keys-race-2"].map((id) =>
            spawnChild({
              parentThreadId: parent,
              threadId: ThreadId.make(id),
              graphKey: "race",
            }).pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
          ),
          { concurrency: "unbounded" },
        );
        const losers = raced.filter((error) => error !== null);
        assert.equal(losers.length, 1);
        assert.include(causeOf(losers[0]!), "already used");
      }),
  );

  it.effect(
    "scaffold is all-or-nothing: a cycle creates nothing; a valid graph creates every node",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const parent = ThreadId.make("scaffold-parent");
        yield* seedThread({ threadId: parent });
        const node = (key: string, blockedBy: ReadonlyArray<string> = []) => ({
          threadId: ThreadId.make(`scaffold-${key}`),
          graphKey: key,
          role: "coder",
          title: `Node ${key}`,
          purpose: null,
          blockedBy: blockedBy.map((dep) => ThreadId.make(`scaffold-${dep}`)),
          modelSelection: testModelSelection,
        });
        const scaffold = (commandId: string, nodes: ReadonlyArray<ReturnType<typeof node>>) =>
          dispatch({
            type: "thread.scaffold",
            commandId: CommandId.make(commandId),
            threadId: parent,
            createdAt: "2026-01-01T00:00:00.000Z",
            held: true,
            nodes,
          });

        const cyclic = yield* Effect.flip(
          scaffold("scaffold-cycle", [node("a", ["b"]), node("b", ["a"])]),
        );
        assert.include(causeOf(cyclic), "cycle");
        assert.deepEqual(yield* store.listChildren(parent), []);

        yield* scaffold("scaffold-ok", [node("x"), node("y", ["x"])]);
        const children = yield* store.listChildren(parent);
        assert.deepEqual(
          children.map((row) => [row.graphKey, row.held, row.blockedBy]).toSorted(),
          [
            ["x", true, []],
            ["y", true, [ThreadId.make("scaffold-x")]],
          ],
        );

        const provider = yield* Effect.flip(
          dispatch({
            type: "thread.spawn",
            commandId: CommandId.make("spawn-provider"),
            threadId: ThreadId.make("scaffold-provider"),
            createdAt: "2026-01-01T00:00:00.000Z",
            createdBy: "agent",
            creationSource: "provider",
            parentThreadId: parent,
            projectId: (yield* store.getWorkstream(parent))!.projectId,
            title: "Provider child",
            modelSelection: testModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            role: null,
            purpose: null,
            goalId: null,
          }),
        );
        assert.include(causeOf(provider), "MCP layer or the server");
      }),
  );
});
