/**
 * On-disk kickoff briefs, ported from V1's `workstreamBrief.ts`. A brief is the
 * markdown a child's first turn is composed from; it lives under
 * `<stateDir>/workstream-briefs/` and its absolute path is event-sourced onto
 * the sidecar as `kickoffBriefPath` (the brief half of a child's start
 * precondition). A brief may be overwritten before kickoff while a kickoff
 * reads it, so the write is atomic: a temp sibling renamed into place.
 *
 * @module loom/workstream/brief
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { loomPaths } from "../loomPaths.ts";

/** Writes a thread's brief atomically and returns its absolute path. */
export const writeWorkstreamBrief = Effect.fn("loom.writeWorkstreamBrief")(function* (
  threadId: ThreadId,
  markdown: string,
) {
  const dir = loomPaths(yield* ServerConfig).workstreamBriefsDir;
  const fs = yield* FileSystem.FileSystem;
  const filePath = (yield* Path.Path).join(dir, `${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`);
  const tempPath = `${filePath}.tmp-${yield* (yield* Crypto.Crypto).randomUUIDv4}`;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(tempPath, markdown);
  yield* fs.rename(tempPath, filePath).pipe(
    // A failed rename must not leave the temp file behind.
    Effect.tapError(() => fs.remove(tempPath).pipe(Effect.ignore)),
  );
  return filePath;
});

/** Reads a brief by its absolute path; none when the file is missing or unreadable. */
export const readWorkstreamBriefAt = Effect.fn("loom.readWorkstreamBriefAt")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});
