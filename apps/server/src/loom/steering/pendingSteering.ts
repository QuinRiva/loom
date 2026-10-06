// loom: 3b STUB for seam 20 — 3c's real module replaces this at integration
/**
 * The pending-steer stash (Phase 3 plan seam 20): `<stateDir>/pending-steering/<threadId>.json`
 * holds one JSON string — the steer text pi accepted but had not folded into the turn when
 * the server stopped. 3c's adapter hunk writes and clears it; 3b's startup pass reads it,
 * redelivers it as a control message and clears it. The file name is the thread id, so
 * `listStashed` enumerates the directory. Never fails: a missing or unreadable stash reads
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

const decodeStash = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));
const encodeStash = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

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
  }).pipe(Effect.ignore);

/** Adds an accepted steer to the thread's stash, after a blank line (3c's signature). */
export const append = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* read(threadId);
    yield* fs.makeDirectory(yield* stashDir, { recursive: true });
    yield* fs.writeFileString(
      yield* stashFile(threadId),
      yield* encodeStash(existing === null ? text : `${existing}\n\n${text}`),
    );
  }).pipe(Effect.ignore);

/** Every thread with a stash file. */
export const listStashed = () =>
  Effect.gen(function* () {
    const names = yield* (yield* FileSystem.FileSystem).readDirectory(yield* stashDir);
    return names.flatMap((name) =>
      name.endsWith(".json") ? [ThreadId.make(name.slice(0, -".json".length))] : [],
    );
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<ThreadId> => []));
