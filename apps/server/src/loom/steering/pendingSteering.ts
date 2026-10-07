/**
 * The pending-steer stash (Phase 3 plan seam 20, P3-24; DL-691):
 * `<stateDir>/pending-steering/<threadId>.json` holds the steers pi has accepted but not yet put
 * into the conversation — a durable mirror of pi's in-memory steering queue, which a restart (or
 * any pi process death) loses — stamped with the run whose turn pi held them for. The pi
 * adapter's marked hunk `write`s pi's `queue_update` steering list on every change; pi drops a
 * steer from that list as it injects it into the conversation (before its user `message_start`),
 * so a consumed steer leaves the stash on its own and the stash is never cleared at turn end.
 *
 * Only a restart that cut the stamped run delivers the stash (DL-694): upstream's restart
 * continuation of that run carries it (`withStashedSteer`, DL-690), else 3b's startup pass
 * redelivers it as a control message or leaves it for the dispatcher's rail. A stash whose run
 * ended any other way (a Stop, a pi death while the server stayed up) died with that pi, as
 * upstream's steers do, and the startup pass discards it. Never fails: the stash must not fail a
 * turn or a startup pass, so every error is logged and swallowed, and a missing or unreadable
 * stash reads as nothing.
 *
 * @module loom/steering/pendingSteering
 */
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { redeliveredSteerText } from "../orchestration/dispatcher/controlMessage.ts";
import { LoomPiAdapterHooks } from "../../provider/Drivers/Pi/loomAdapterHooks.loom.ts";

const stashDir = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  return (yield* Path.Path).join(stateDir, "pending-steering");
});

const stashFile = (threadId: ThreadId) =>
  Effect.map(Effect.zip(stashDir, Path.Path), ([dir, path]) => path.join(dir, `${threadId}.json`));

const StashFile = Schema.fromJsonString(
  Schema.Struct({ runId: Schema.NullOr(Schema.String), steering: Schema.Array(Schema.String) }),
);
const decodeStash = Schema.decodeUnknownEffect(StashFile);
const encodeStash = Schema.encodeEffect(StashFile);

/**
 * The stash: its run, and its steers in send order joined by a blank line (one redelivery carries
 * them all); null when there is none.
 */
export const read = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { runId, steering } = yield* decodeStash(
      yield* fs.readFileString(yield* stashFile(threadId)),
    );
    return steering.length > 0 ? { runId, text: steering.join("\n\n") } : null;
  }).pipe(Effect.orElseSucceed(() => null));

/** Mirrors pi's steering queue for `runId`'s turn (atomic: temp file, then rename); an empty queue removes the stash. */
export const write = (threadId: ThreadId, runId: string | null, steering: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* stashFile(threadId);
    if (steering.length === 0) return yield* fs.remove(file, { force: true });
    yield* fs.makeDirectory(yield* stashDir, { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    yield* fs.writeFileString(temp, yield* encodeStash({ runId, steering }));
    yield* fs.rename(temp, file);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("loom.steer-stash.write-failed", { threadId, cause }),
    ),
  );

/** Removes the stash once its steer is delivered, unless pi has mirrored a newer queue since (`read` ≠ `delivered`). */
export const clear = (threadId: ThreadId, delivered: string | null) =>
  Effect.gen(function* () {
    if (((yield* read(threadId))?.text ?? null) === delivered) yield* write(threadId, null, []);
  });

/** Every thread with a stash file. */
export const listStashed = () =>
  Effect.gen(function* () {
    const names = yield* (yield* FileSystem.FileSystem).readDirectory(yield* stashDir);
    return names.flatMap((name) =>
      name.endsWith(".json") ? [ThreadId.make(name.slice(0, -".json".length))] : [],
    );
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<ThreadId> => []));

/**
 * Upstream's restart-continuation prompt for `sourceRunId`, with the steers stashed from that run
 * after it (DL-690): they were accepted into the cut turn, so they ride the turn that resumes it —
 * first after the restart, ahead of every queued message, and past a human-held queue. A stash
 * from any other run is not this turn's (DL-694). Read through the adapter hooks' reference, so
 * upstream's callers gain no requirement; the startup pass clears it.
 */
export const withStashedSteer = (threadId: ThreadId, sourceRunId: string, text: string) =>
  Effect.gen(function* () {
    const stash = yield* (yield* LoomPiAdapterHooks).steerStash.read(threadId);
    return stash?.runId === sourceRunId ? `${text}\n\n${redeliveredSteerText(stash.text)}` : text;
  });
