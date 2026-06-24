/**
 * workstreamReport - On-disk storage for Workstream completion reports.
 *
 * A sub-thread records a deliberate markdown handoff (not its whole transcript)
 * via the `workstream_report` tool. The markdown is stored as a file under the
 * durable per-thread reports directory (NOT the ephemeral worktree), and only a
 * tiny path pointer is event-sourced onto the thread record. The dispatcher
 * reads the file when composing the parent wake message.
 *
 * @module workstreamReport
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";

/** Filesystem-safe report file name for a thread (threadIds are uuids). */
export const workstreamReportFileName = (threadId: ThreadId): string =>
  `${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`;

/**
 * Persist a sub-thread's completion report and return the stored pointer (the
 * report file name, resolved against the reports dir on read). Overwrites any
 * previous report for the thread — the latest handoff is the source of truth.
 */
export const writeWorkstreamReport = Effect.fn("writeWorkstreamReport")(function* (
  threadId: ThreadId,
  markdown: string,
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fileName = workstreamReportFileName(threadId);
  yield* fs.makeDirectory(config.workstreamReportsDir, { recursive: true });
  yield* fs.writeFileString(path.join(config.workstreamReportsDir, fileName), markdown);
  return fileName;
});

/** Read a thread's completion report markdown, if one exists. */
export const readWorkstreamReport = Effect.fn("readWorkstreamReport")(function* (
  threadId: ThreadId,
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.workstreamReportsDir, workstreamReportFileName(threadId));
  return yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});
