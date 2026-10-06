/**
 * On-disk workstream reports (Phase 3 plan seam 7), ported from V1's
 * `workstreamReport.ts` minus the search-index call. A sub-thread's hand-back
 * is a markdown file under `<stateDir>/workstream-reports/` (durable, never the
 * worktree); its absolute path is event-sourced onto the sidecar as
 * `reportPath`, so the parent — whose cwd is its own worktree — reads it
 * directly. The quiescence rail writes a synthesised report beside them.
 *
 * Two tracks land this seam (3a-2 for `mcp__t3-code__workstream_submit`, 3b for the
 * quiescence rail); integration keeps one copy.
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
import { QUIESCENT_REPORT_HEADER } from "../prompt/prose.ts";

const fileStem = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

const writeReportFile = Effect.fn("loom.writeReportFile")(function* (
  fileName: string,
  markdown: string,
) {
  const dir = loomPaths(yield* ServerConfig).workstreamReportsDir;
  const fs = yield* FileSystem.FileSystem;
  const filePath = (yield* Path.Path).join(dir, fileName);
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
 * `<threadId>.quiescent-<run>.md`, where `<run>` is the run id minus the thread id
 * it embeds: a V2 run id is `run:thread:<URI-encoded threadId>:ordinal:<n>`, and a
 * spawned child's id is long enough that repeating it overflows the 255-byte
 * filename limit (DL-470) — so a child's file is `<threadId>.quiescent-ordinal_<n>.md`.
 */
export const synthesisedReportFileName = (threadId: ThreadId, runId: string) =>
  `${fileStem(threadId)}.quiescent-${fileStem(runId.split(`${encodeURIComponent(threadId)}:`).at(-1)!)}.md`;

/**
 * Writes the quiescence rail's report for a thread that ended `runId` without
 * submitting — the fixed header (with `grace` rendered by the caller, e.g.
 * "10 min"), a blank line, then its last assistant message — and returns its
 * absolute path (`synthesisedReportFileName`).
 */
export const writeSynthesisedReport = (
  threadId: ThreadId,
  runId: string,
  lastAssistantText: string,
  grace: string,
) =>
  writeReportFile(
    synthesisedReportFileName(threadId, runId),
    `${QUIESCENT_REPORT_HEADER.replace("<grace>", grace)}\n\n${lastAssistantText}`,
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
