/**
 * On-disk workstream reports (Phase 3 plan seam 7), ported from V1's
 * `workstreamReport.ts` minus the search-index call. A sub-thread's hand-back
 * is a markdown file under `<stateDir>/workstream-reports/` (durable, never the
 * worktree); its absolute path is event-sourced onto the sidecar as
 * `reportPath`, so the parent — whose cwd is its own worktree — reads it
 * directly. The quiescence rail writes a synthesised report beside them.
 *
 * The directory is `loomPaths(...).workstreamReportsDir` (DL-360: no
 * `config.ts` hunk); every write creates it.
 *
 * @module loom/workstream/report
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { loomPaths } from "../loomPaths.ts";

const fileStem = (threadId: ThreadId) => threadId.replace(/[^A-Za-z0-9._-]/g, "_");

const writeReportFile = Effect.fn("loom.writeReportFile")(function* (
  fileName: string,
  markdown: string,
) {
  const dir = (yield* loomPaths(yield* ServerConfig)).workstreamReportsDir;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(dir, fileName);
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(filePath, markdown);
  return filePath;
});

/**
 * Writes a submitted report and returns its absolute path:
 * `<threadId>.md`, or `<threadId>.round-<n>.md` inside a gate loop so each
 * routed round keeps its own file. Overwrites a previous file of the same name.
 */
export const writeWorkstreamReport = (threadId: ThreadId, markdown: string, round?: number) =>
  writeReportFile(
    `${fileStem(threadId)}${round === undefined ? "" : `.round-${round}`}.md`,
    markdown,
  );

/**
 * Writes the quiescence rail's report for a thread that ended `runId` without
 * submitting — the fixed header (with `grace` rendered by the caller, e.g.
 * "10 min"), a blank line, then its last assistant message — and returns the
 * absolute path `<threadId>.quiescent-<runId>.md`.
 */
export const writeSynthesisedReport = (
  threadId: ThreadId,
  runId: string,
  lastAssistantText: string,
  grace: string,
) =>
  writeReportFile(
    `${fileStem(threadId)}.quiescent-${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`,
    [
      "> **Synthesised report.** This thread ended its turn without calling `mcp__t3-code__workstream_submit`.",
      `> The control plane wrote this file from its last assistant message after ${grace} of silence`,
      "> and yielded it to the parent. Nothing below was written as a hand-back.",
      "",
      lastAssistantText,
    ].join("\n"),
  );

/** Reads a report by its event-sourced absolute path; none when the file is missing or unreadable. */
export const readWorkstreamReportAt = Effect.fn("loom.readWorkstreamReportAt")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});
