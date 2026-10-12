import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as PendingSteering from "./pendingSteering.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-pending-steering-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("pending-steer stash", (it) => {
  it.effect("reads a missing stash as null and clears it without failing", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("no-stash");
      assert.isNull(yield* PendingSteering.read(threadId));
      yield* PendingSteering.clear(threadId, null);
      assert.deepEqual(yield* PendingSteering.listStashed(), []);
    }),
  );

  it.effect("mirrors pi's queue with its run, read joined in send order", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("stashed");
      yield* PendingSteering.write(threadId, "run-a", ["first"], null);
      yield* PendingSteering.write(threadId, "run-a", ["first", "second"], null);
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const file = (yield* Path.Path).join(stateDir, "pending-steering", `${threadId}.json`);
      assert.equal(
        yield* (yield* FileSystem.FileSystem).readFileString(file),
        '{"runId":"run-a","steering":["first","second"],"transcript":null}',
      );
      assert.deepEqual(yield* PendingSteering.read(threadId), {
        runId: "run-a",
        text: "first\n\nsecond",
      });
      assert.deepEqual(yield* PendingSteering.listStashed(), [threadId]);
      // A delivery clears only what it delivered: a newer mirror stays.
      yield* PendingSteering.clear(threadId, "first");
      assert.isNotNull(yield* PendingSteering.read(threadId));
      yield* PendingSteering.clear(threadId, "first\n\nsecond");
      assert.isNull(yield* PendingSteering.read(threadId));
      // pi consumed every steer: an empty queue removes the file.
      yield* PendingSteering.write(threadId, "run-b", ["third"], null);
      yield* PendingSteering.write(threadId, "run-b", [], null);
      assert.deepEqual(yield* PendingSteering.listStashed(), []);
    }),
  );

  // DL-1002: the server died first, so pi's last `queue_update` never reached the stash, but pi
  // still put the steer into its session file before it died.
  it.effect("drops a steer pi's session file shows it delivered after the stash was written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const threadId = ThreadId.make("delivered-while-dying");
      const session = (yield* Path.Path).join(
        (yield* ServerConfig.ServerConfig).stateDir,
        "session.jsonl",
      );
      const user = (text: string) =>
        `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
      // "second" was also sent once before this turn: that earlier message is not this delivery.
      yield* fs.writeFileString(session, user("second"));
      yield* PendingSteering.write(threadId, "run-a", ["first", "second"], session);
      yield* fs.writeFileString(session, user("first"), { flag: "a" });
      assert.deepEqual(yield* PendingSteering.read(threadId), { runId: "run-a", text: "second" });

      yield* fs.writeFileString(session, user("second"), { flag: "a" });
      assert.isNull(yield* PendingSteering.read(threadId));
      // The startup pass clears a stash that reads as nothing.
      yield* PendingSteering.clear(threadId, null);
      assert.deepEqual(yield* PendingSteering.listStashed(), []);
    }),
  );

  it.effect("reads a stash written before pi's first reply against its whole session file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const threadId = ThreadId.make("no-session-yet");
      const session = (yield* Path.Path).join(
        (yield* ServerConfig.ServerConfig).stateDir,
        "late-session.jsonl",
      );
      yield* PendingSteering.write(threadId, "run-a", ["only"], session);
      assert.deepEqual(yield* PendingSteering.read(threadId), { runId: "run-a", text: "only" });
      yield* fs.writeFileString(
        session,
        `${JSON.stringify({ type: "message", message: { role: "user", content: "only" } })}\n`,
      );
      assert.isNull(yield* PendingSteering.read(threadId));
    }),
  );
});
