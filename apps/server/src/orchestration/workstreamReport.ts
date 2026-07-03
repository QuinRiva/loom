/**
 * workstreamReport - On-disk storage for Workstream completion reports.
 *
 * A sub-thread records a deliberate markdown handoff (not its whole transcript)
 * via the `workstream_submit` tool. The markdown is stored as a file under the
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

/**
 * Filesystem-safe report file name for a thread (threadIds are uuids). Inside a
 * review-gate loop each routed round conserves its own file
 * (`<threadId>.round-<n>.md`, risk R2); round-0 / non-gate submits keep the
 * plain `<threadId>.md`. The event-sourced `reportPath` pointer tracks the
 * latest either way.
 */
export const workstreamReportFileName = (threadId: ThreadId, round?: number | null): string =>
  `${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}${round != null ? `.round-${round}` : ""}.md`;

/**
 * Persist a sub-thread's completion report and return the absolute path to the
 * stored file. The parent orchestrator runs with its CWD set to its own
 * worktree, so the handed-back reference must be an absolute path it can read
 * directly — a bare file name would not resolve there. Overwrites any previous
 * report AT THE SAME NAME — the latest handoff is the source of truth; gate
 * rounds write distinct per-round names so loop history is conserved.
 */
export const writeWorkstreamReport = Effect.fn("writeWorkstreamReport")(function* (
  threadId: ThreadId,
  markdown: string,
  round?: number | null,
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(
    config.workstreamReportsDir,
    workstreamReportFileName(threadId, round),
  );
  yield* fs.makeDirectory(config.workstreamReportsDir, { recursive: true });
  yield* fs.writeFileString(filePath, markdown);
  return filePath;
});

/** Read a thread's completion report markdown, if one exists. */
export const readWorkstreamReport = Effect.fn("readWorkstreamReport")(function* (
  threadId: ThreadId,
) {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  return yield* readWorkstreamReportAt(
    path.join(config.workstreamReportsDir, workstreamReportFileName(threadId)),
  );
});

/**
 * Read a report by its event-sourced absolute path (the `reportPath` pointer).
 * Preferred over `readWorkstreamReport` whenever the pointer is at hand: inside
 * a gate loop the latest report lives in a per-round file the fixed-name read
 * would miss.
 */
export const readWorkstreamReportAt = Effect.fn("readWorkstreamReportAt")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});
