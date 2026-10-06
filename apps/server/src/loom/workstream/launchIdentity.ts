/**
 * A thread's launch identity: the composed prompt, skills, extensions, env,
 * model selection and active-tool profile its first pi launch used, written
 * once to `<workstreamLaunchIdentityDir>/<threadId>.json`. Every later compose
 * for the thread returns these bytes (a relaunch after a role-file edit stays
 * byte-identical, so its cached prefix survives), a `forkFrom` child launches
 * from its source's record verbatim (the acknowledge-then-fork cache prefix),
 * and the session-profile route serves the recorded profile so the served
 * profile is the launched one (plan P3-23, seam 4).
 *
 * @module loom/workstream/launchIdentity
 */
import { ModelSelection, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const LaunchIdentityRecord = Schema.Struct({
  appendSystemPrompt: Schema.String,
  skills: Schema.Array(Schema.String),
  extensions: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  modelSelection: ModelSelection,
  /** The active-tool profile; `[]` = unprofiled (pi's full surface minus the deny-list). */
  tools: Schema.Array(Schema.String),
});
export type LaunchIdentityRecord = typeof LaunchIdentityRecord.Type;

const LaunchIdentityJson = Schema.fromJsonString(LaunchIdentityRecord);
const decodeRecord = Schema.decodeUnknownOption(LaunchIdentityJson);
const encodeRecord = Schema.encodeSync(LaunchIdentityJson);

const identityPath = (path: Path.Path, dir: string, threadId: ThreadId) =>
  path.join(dir, `${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

/**
 * The thread's record, or none. A file that does not decode (a V1-shaped
 * record left in the same directory) reads as none, so the thread composes
 * afresh and a fork of it refuses rather than replaying V1's argv.
 */
export const readLaunchIdentity = Effect.fn("readLaunchIdentity")(function* (
  dir: string,
  threadId: ThreadId,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(identityPath(path, dir, threadId)).pipe(
    Effect.map(decodeRecord),
    Effect.orElseSucceed(() => Option.none<LaunchIdentityRecord>()),
  );
});

/** Writes the record (temp sibling + rename, so a reader never sees a torn file). */
export const writeLaunchIdentity = Effect.fn("writeLaunchIdentity")(function* (
  dir: string,
  threadId: ThreadId,
  record: LaunchIdentityRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = identityPath(path, dir, threadId);
  const temp = `${target}.tmp-${process.pid}`;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(temp, encodeRecord(record));
  yield* fs.rename(temp, target);
});
