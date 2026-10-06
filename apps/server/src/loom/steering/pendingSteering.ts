/**
 * The pending-steer stash (Phase 3 plan seam 20, P3-24): `<stateDir>/pending-steering/<threadId>.json`
 * holds one JSON string — the steer text pi accepted into a live turn that the turn has not
 * finished with. The pi adapter's marked hunks `append` when pi acks a steer and `clear` when
 * the turn ends (through `LoomPiAdapterHooks.steerStash`); 3b's startup recovery pass `read`s
 * each `listStashed` thread, redelivers the text as a control message and `clear`s it. A second
 * accepted steer in the same turn is appended after a blank line, so one redelivery carries
 * every stashed steer verbatim in send order. Never fails: the stash must not fail a turn or a
 * startup pass, so every error is logged and swallowed, and a missing or unreadable stash reads
 * as nothing.
 *
 * @module loom/steering/pendingSteering
 */
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";

const stashDir = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  return (yield* Path.Path).join(stateDir, "pending-steering");
});

const stashFile = (threadId: ThreadId) =>
  Effect.map(Effect.zip(stashDir, Path.Path), ([dir, path]) => path.join(dir, `${threadId}.json`));

const StashFile = Schema.fromJsonString(Schema.String);
const decodeStash = Schema.decodeUnknownEffect(StashFile);
const encodeStash = Schema.encodeEffect(StashFile);

/** The stashed steer text for a thread, or null when there is none. */
export const read = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* decodeStash(yield* fs.readFileString(yield* stashFile(threadId)));
    return text.length > 0 ? text : null;
  }).pipe(Effect.orElseSucceed(() => null));

/** Removes a thread's stash (idempotent). */
export const clear = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).remove(yield* stashFile(threadId), { force: true });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("loom.steer-stash.clear-failed", { threadId, cause }),
    ),
  );

/** Adds an accepted steer to the thread's stash (atomic: temp file, then rename). */
export const append = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* stashFile(threadId);
    const existing = yield* read(threadId);
    yield* fs.makeDirectory(yield* stashDir, { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    yield* fs.writeFileString(
      temp,
      yield* encodeStash(existing === null ? text : `${existing}\n\n${text}`),
    );
    yield* fs.rename(temp, file);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("loom.steer-stash.append-failed", { threadId, cause }),
    ),
  );

/** Every thread with a stash file. */
export const listStashed = () =>
  Effect.gen(function* () {
    const names = yield* (yield* FileSystem.FileSystem).readDirectory(yield* stashDir);
    return names.flatMap((name) =>
      name.endsWith(".json") ? [ThreadId.make(name.slice(0, -".json".length))] : [],
    );
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<ThreadId> => []));
