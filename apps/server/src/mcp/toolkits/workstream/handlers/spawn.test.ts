/**
 * mcp__t3-code__workstream_spawn / mcp__t3-code__workstream_scaffold / mcp__t3-code__workstream_brief on V2's real
 * orchestrator: the sidecar row and subagent lineage, a row-less parent's
 * sidecar (DL-225), forkFrom's implied edge and inherited identity, the gate's
 * routes, scaffold's all-or-nothing references, and the brief file + path.
 */
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import {
  loomEvent,
  seedThread,
  writeEvents,
} from "../../../../loom/testkit/loomOrchestratorLayer.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import { callAs, HandlerTestLayer, spawnedId } from "./handlers.testkit.ts";

const spawnNode = (title: string, extra: Record<string, unknown> = {}) => ({
  role: "coder",
  title,
  purpose: `Deliver ${title}.`,
  ...extra,
});

it.layer(HandlerTestLayer)("workstream spawn, scaffold and brief", (it) => {
  it.effect(
    "spawn: a row-less parent gains its sidecar; the child has subagent lineage, its row and its brief",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const parent = ThreadId.make("spawn-root");
        yield* seedThread({ threadId: parent });
        assert.isNull(yield* store.getWorkstream(parent));

        const result = yield* callAs(parent, "workstream_spawn", {
          ...spawnNode("Receipt dedup"),
          brief: "Make receipts idempotent.",
        });
        assert.isFalse(result.isError, result.text);
        const child = spawnedId(result.text);

        assert.isNotNull(yield* store.getWorkstream(parent));
        const shell = (yield* orchestrator.getThreadShell(child))!;
        assert.deepEqual(shell.lineage, {
          parentThreadId: parent,
          relationshipToParent: "subagent",
          rootThreadId: parent,
        });
        const row = (yield* store.getWorkstream(child))!;
        assert.equal(row.role, "coder");
        assert.equal(row.purpose, "Deliver Receipt dedup.");
        assert.isNull(row.kickoffAt);
        const brief = yield* (yield* FileSystem.FileSystem).readFileString(row.kickoffBriefPath!);
        assert.equal(brief, "Make receipts idempotent.");
      }),
  );

  it.effect(
    "spawn: forkFrom inherits the source's identity and waits on it; identity fields are refused",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const parent = ThreadId.make("fork-root");
        yield* seedThread({ threadId: parent });
        const source = spawnedId(
          (yield* callAs(parent, "workstream_spawn", spawnNode("Reader", { role: "researcher" })))
            .text,
        );

        const refused = yield* callAs(parent, "workstream_spawn", {
          ...spawnNode("Fork"),
          forkFrom: source,
        });
        assert.isTrue(refused.isError);
        assert.include(refused.text, "role cannot be combined with forkFrom");

        const forked = yield* callAs(parent, "workstream_spawn", {
          title: "Fork",
          purpose: "Act on what the reader learned.",
          forkFrom: source,
        });
        assert.isFalse(forked.isError, forked.text);
        assert.include(forked.text, `forkFrom ${source} was added to blockedBy automatically`);
        const row = (yield* store.getWorkstream(spawnedId(forked.text)))!;
        assert.deepEqual(row.blockedBy, [source]);
        assert.equal(row.forkFromThreadId, source);
        assert.equal(row.role, "researcher");
      }),
  );

  it.effect("spawn: a gate loops rework to its target and waits on it", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const parent = ThreadId.make("gate-root");
      yield* seedThread({ threadId: parent });
      const coder = spawnedId((yield* callAs(parent, "workstream_spawn", spawnNode("Coder"))).text);
      const reviewer = spawnedId(
        (yield* callAs(
          parent,
          "workstream_spawn",
          spawnNode("Review", { role: "reviewer", gate: { rework: coder, maxRounds: 3 } }),
        )).text,
      );
      const row = (yield* store.getWorkstream(reviewer))!;
      assert.deepEqual(row.blockedBy, [coder]);
      assert.deepEqual(row.routes, [
        { on: ["needs_rework"], kind: "loop", to: coder, maxRounds: 3 },
        { on: ["clean", "fixed_inline"], kind: "resolve" },
      ]);
    }),
  );

  it.effect("scaffold: UUID-shaped keys and dangling references create nothing", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const parent = ThreadId.make("scaffold-refused-root");
      yield* seedThread({ threadId: parent });

      const uuid = yield* callAs(parent, "workstream_scaffold", {
        nodes: [{ key: "0b3c0f8e-1111-4222-8333-944455556666", ...spawnNode("A") }],
      });
      assert.isTrue(uuid.isError);
      assert.include(uuid.text, "UUID-shaped");

      const dangling = yield* callAs(parent, "workstream_scaffold", {
        nodes: [
          { key: "a", ...spawnNode("A") },
          { key: "b", ...spawnNode("B"), blockedBy: ["missing"] },
        ],
      });
      assert.isTrue(dangling.isError);
      assert.include(dangling.text, 'node "b"');
      assert.include(dangling.text, "Nothing was created.");

      // The arm's own refusal names nodes by key.
      const cycle = yield* callAs(parent, "workstream_scaffold", {
        nodes: [
          { key: "a", ...spawnNode("A"), blockedBy: ["b"] },
          { key: "b", ...spawnNode("B"), blockedBy: ["a"] },
        ],
      });
      assert.isTrue(cycle.isError);
      assert.match(
        cycle.text,
        /cycle \(node "[ab]" → node "[ab]" → node "[ab]"\)\. Nothing was created\.$/,
      );
      assert.lengthOf(yield* store.listChildren(parent), 0);
    }),
  );

  it.effect(
    "scaffold: keys and thread ids (as printed or `thread:`-prefixed) resolve; nodes are created unbriefed; brief writes the file",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const parent = ThreadId.make("scaffold-root");
        yield* seedThread({ threadId: parent });
        const existing = spawnedId(
          (yield* callAs(parent, "workstream_spawn", spawnNode("Existing"))).text,
        );

        const result = yield* callAs(parent, "workstream_scaffold", {
          nodes: [
            // The id as printed (a spawned child's id already starts with `thread:`).
            { key: "coder", ...spawnNode("Coder"), blockedBy: [existing] },
            {
              key: "review",
              ...spawnNode("Review", { role: "reviewer", gate: { rework: "coder" } }),
            },
          ],
        });
        assert.isFalse(result.isError, result.text);
        const children = yield* store.listChildren(parent);
        const coder = children.find((child) => child.graphKey === "coder")!;
        const review = children.find((child) => child.graphKey === "review")!;
        assert.deepEqual(coder.blockedBy, [existing]);
        assert.deepEqual(review.blockedBy, [coder.threadId]);
        assert.isNull(coder.kickoffBriefPath);

        const briefed = yield* callAs(parent, "workstream_brief", {
          node: coder.threadId,
          markdown: "# Do the work",
        });
        assert.isFalse(briefed.isError, briefed.text);
        const path = (yield* store.getWorkstream(coder.threadId))!.kickoffBriefPath!;
        assert.include(briefed.text, path);
        assert.equal(yield* (yield* FileSystem.FileSystem).readFileString(path), "# Do the work");

        // A started child's brief is fixed.
        yield* writeEvents([
          yield* loomEvent("thread.kickoff-recorded", review.threadId, {
            kickoffAt: DateTime.formatIso(yield* DateTime.now),
            messageId: "message:started" as never,
            origin: "user",
          }),
        ]);
        const late = yield* callAs(parent, "workstream_brief", {
          node: `thread:${review.threadId}`,
          markdown: "too late",
        });
        assert.isTrue(late.isError);
        assert.include(late.text, "has already started");
      }),
  );
});
