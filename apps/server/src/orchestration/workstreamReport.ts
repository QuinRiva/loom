/**
 * workstreamReport - On-disk storage for Workstream completion reports.
 *
 * A sub-thread records a deliberate markdown handoff (not its whole transcript)
 * via the `workstream_report` tool. The markdown is stored as a file under the
 * durable per-thread reports directory (NOT the ephemeral worktree), and the
 * absolute path to that file is event-sourced onto the thread record so the
 * parent orchestrator (whose CWD is its own worktree) can read it directly.
 * The dispatcher reads the file when composing the parent wake message.
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
 * Persist a sub-thread's completion report and return the absolute path to the
 * stored file. The parent orchestrator runs with its CWD set to its own
 * worktree, so the handed-back reference must be an absolute path it can read
 * directly — a bare file name would not resolve there. Overwrites any previous
 * report for the thread — the latest handoff is the source of truth.
 */
export const writeWorkstreamReport = Effect.fn("writeWorkstreamReport")(function* (
  threadId: ThreadId,
  markdown: string,
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.workstreamReportsDir, workstreamReportFileName(threadId));
  yield* fs.makeDirectory(config.workstreamReportsDir, { recursive: true });
  yield* fs.writeFileString(filePath, markdown);
  return filePath;
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
