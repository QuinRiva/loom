/**
 * workstreamBrief - On-disk storage for Workstream kickoff briefs.
 *
 * Scaffold-first graph authoring (workstream-scaffold plan) splits graph
 * authoring into a cheap `workstream_scaffold` (topology only) and a per-node
 * `workstream_brief` that attaches the token-heavy kickoff brief just-in-time.
 * The brief markdown is stored as a file under the durable per-thread briefs
 * directory (NOT the ephemeral worktree), and the absolute path is event-sourced
 * onto the thread record (`kickoffBriefPath`). The dispatcher reads the file at
 * the child's first launch to compose the kickoff turn.
 *
 * Unlike `workstreamReport` (whose file is written once at submit), a brief may
 * be overwritten pre-launch and read concurrently by a kickoff, so the write is
 * ATOMIC: the markdown is written to a temp sibling and renamed into place, so a
 * kickoff never observes a torn file.
 *
 * @module workstreamBrief
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";

/** Filesystem-safe brief file name for a thread (threadIds are uuids). */
export const workstreamBriefFileName = (threadId: ThreadId): string =>
  `${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`;

/**
 * Persist a thread's kickoff brief atomically and return the absolute path to
 * the stored file. The write goes to a uniquely-named temp sibling first, then
 * renames into place — rename is atomic within a directory, so a concurrent
 * kickoff read sees either the old or the new content, never a partial write.
 * Overwrites any previous brief at the same name (pre-launch editing is the
 * expected path).
 */
export const writeWorkstreamBrief = Effect.fn("writeWorkstreamBrief")(function* (
  threadId: ThreadId,
  markdown: string,
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  yield* fs.makeDirectory(config.workstreamBriefsDir, { recursive: true });
  const filePath = path.join(config.workstreamBriefsDir, workstreamBriefFileName(threadId));
  const tempPath = `${filePath}.tmp-${yield* crypto.randomUUIDv4}`;
  yield* fs.writeFileString(tempPath, markdown);
  yield* fs.rename(tempPath, filePath).pipe(
    // A rename failure must not leave the temp file behind.
    Effect.tapError(() => fs.remove(tempPath).pipe(Effect.orElseSucceed(() => undefined))),
  );
  return filePath;
});

/** Read a thread's kickoff brief markdown by its absolute path, if it exists. */
export const readWorkstreamBriefAt = Effect.fn("readWorkstreamBriefAt")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});
