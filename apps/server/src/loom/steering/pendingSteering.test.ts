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

  it.effect("mirrors pi's queue as a JSON array, read joined in send order", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("stashed");
      yield* PendingSteering.write(threadId, ["first"]);
      yield* PendingSteering.write(threadId, ["first", "second"]);
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const file = (yield* Path.Path).join(stateDir, "pending-steering", `${threadId}.json`);
      assert.equal(
        yield* (yield* FileSystem.FileSystem).readFileString(file),
        '["first","second"]',
      );
      assert.equal(yield* PendingSteering.read(threadId), "first\n\nsecond");
      assert.deepEqual(yield* PendingSteering.listStashed(), [threadId]);
      // A delivery clears only what it delivered: a newer mirror stays.
      yield* PendingSteering.clear(threadId, "first");
      assert.equal(yield* PendingSteering.read(threadId), "first\n\nsecond");
      yield* PendingSteering.clear(threadId, "first\n\nsecond");
      assert.isNull(yield* PendingSteering.read(threadId));
      // pi consumed every steer: an empty queue removes the file.
      yield* PendingSteering.write(threadId, ["third"]);
      yield* PendingSteering.write(threadId, []);
      assert.deepEqual(yield* PendingSteering.listStashed(), []);
    }),
  );
});
