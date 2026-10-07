/**
 * The pending-steer stash (Phase 3 plan seam 20, P3-24; DL-691):
 * `<stateDir>/pending-steering/<threadId>.json` holds a JSON array of the steers pi has accepted
 * but not yet put into the conversation — a durable mirror of pi's in-memory steering queue,
 * which a restart (or any pi process death) loses. The pi adapter's marked hunk `write`s pi's
 * `queue_update` steering list on every change; pi drops a steer from that list as it injects it
 * into the conversation (before its user `message_start`), so a consumed steer leaves the stash
 * on its own and the stash is never cleared at turn end.
 *
 * After a restart the stash holds what the dead pi never delivered: upstream's restart
 * continuation carries it (`withStashedSteer`, DL-690), else 3b's startup pass redelivers it as a
 * control message or leaves it for the dispatcher's rail. Never fails: the stash must not fail a
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

const StashFile = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeStash = Schema.decodeUnknownEffect(StashFile);
const encodeStash = Schema.encodeEffect(StashFile);

/** The stashed steers in send order, joined by a blank line (one redelivery carries them all), or null. */
export const read = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const steering = yield* decodeStash(yield* fs.readFileString(yield* stashFile(threadId)));
    return steering.length > 0 ? steering.join("\n\n") : null;
  }).pipe(Effect.orElseSucceed(() => null));

/** Mirrors pi's steering queue (atomic: temp file, then rename); an empty queue removes the stash. */
export const write = (threadId: ThreadId, steering: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* stashFile(threadId);
    if (steering.length === 0) return yield* fs.remove(file, { force: true });
    yield* fs.makeDirectory(yield* stashDir, { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    yield* fs.writeFileString(temp, yield* encodeStash(steering));
    yield* fs.rename(temp, file);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("loom.steer-stash.write-failed", { threadId, cause }),
    ),
  );

/** Removes the stash once its steer is delivered, unless pi has mirrored a newer queue since (`read` ≠ `delivered`). */
export const clear = (threadId: ThreadId, delivered: string | null) =>
  Effect.gen(function* () {
    if ((yield* read(threadId)) === delivered) yield* write(threadId, []);
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
 * Upstream's restart-continuation prompt with the thread's stashed steer after it (DL-690): the
 * steer was accepted into the cut turn, so it rides the turn that resumes that turn — first after
 * the restart, ahead of every queued message, and past a human-held queue. Read through the
 * adapter hooks' reference, so upstream's callers gain no requirement; the startup pass clears it.
 */
export const withStashedSteer = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const steer = yield* (yield* LoomPiAdapterHooks).steerStash.read(threadId);
    return steer === null ? text : `${text}\n\n${redeliveredSteerText(steer)}`;
  });
