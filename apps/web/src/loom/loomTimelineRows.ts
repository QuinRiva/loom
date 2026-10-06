/**
 * loom: the Loom rows spliced into a thread's timeline (3d-3) — consult rows
 * and handoff receipts, both derived from the V2 shell alone:
 *
 * - **consult** — one row per target this thread consulted
 *   (`shell.workstream.consults`, newest exchange's question), placed at the
 *   last consult. The per-call question and answer stay on the tool row.
 * - **handoff receipt** — one row per root that continues this thread
 *   (`workstream.continuesThreadId === this`, the `goal_continue` shape),
 *   placed at its creation, naming where the work went and whether it is
 *   staged, launched or settled. V1 read the source's `handoffDestinations`,
 *   which the shell no longer carries (DL-435).
 *
 * Placement is insertion, not a re-sort: each row lands before the first
 * strictly later row, above the working indicator when nothing later exists.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LoomThreadConsultSummary, LoomThreadShellFields, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import type { MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { environmentSnapshotAtom } from "~/state/shell";

export type LoomHandoffState = "staged" | "launched" | "done" | "cancelled";

export type LoomTimelineRow =
  | {
      readonly kind: "loom-consult";
      readonly id: string;
      readonly createdAt: string;
      readonly consult: LoomThreadConsultSummary;
    }
  | {
      readonly kind: "loom-handoff";
      readonly id: string;
      readonly createdAt: string;
      readonly successor: {
        readonly threadId: ThreadId;
        readonly title: string;
        readonly state: LoomHandoffState;
      };
    };

const EMPTY_ROWS: ReadonlyArray<LoomTimelineRow> = Object.freeze([]);

const handoffState = (workstream: LoomThreadShellFields): LoomHandoffState =>
  workstream.outcome ?? (workstream.held ? "staged" : "launched");

const loomRowsAtom = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  let previous = EMPTY_ROWS;
  let previousKey = "";
  return Atom.make((get) => {
    const threads = ref === null ? null : get(environmentSnapshotAtom(ref.environmentId))?.threads;
    if (!ref || !threads) return EMPTY_ROWS;
    const self = threads.find((thread) => thread.id === ref.threadId);
    const rows: LoomTimelineRow[] = [
      ...(self?.workstream?.consults ?? []).map((consult) => ({
        kind: "loom-consult" as const,
        id: `loom-consult:${consult.targetThreadId}`,
        createdAt: consult.lastConsultAt,
        consult,
      })),
      ...threads
        .filter(
          (thread) =>
            thread.workstream?.continuesThreadId === ref.threadId &&
            thread.lineage.parentThreadId === null,
        )
        .map((thread) => ({
          kind: "loom-handoff" as const,
          id: `loom-handoff:${thread.id}`,
          createdAt: DateTime.formatIso(thread.createdAt),
          successor: {
            threadId: thread.id,
            title: thread.title,
            state: handoffState(thread.workstream!),
          },
        })),
    ];
    // Shell churn is constant; hand back the same array unless a row changed.
    const key = JSON.stringify(rows);
    if (key !== previousKey) {
      previousKey = key;
      previous = rows.length === 0 ? EMPTY_ROWS : rows;
    }
    return previous;
  }).pipe(Atom.withLabel(`loom-timeline-rows:${threadKey}`));
});

export function useLoomTimelineRows(threadKey: string): ReadonlyArray<LoomTimelineRow> {
  return useAtomValue(loomRowsAtom(threadKey));
}

export function insertLoomTimelineRows(
  rows: MessagesTimelineRow[],
  loomRows: ReadonlyArray<LoomTimelineRow>,
): MessagesTimelineRow[] {
  if (loomRows.length === 0) return rows;
  const result = [...rows];
  for (const row of loomRows) {
    const index = result.findIndex(
      (candidate) => candidate.createdAt !== null && candidate.createdAt > row.createdAt,
    );
    const at = index !== -1 ? index : result.findIndex((candidate) => candidate.kind === "working");
    result.splice(at === -1 ? result.length : at, 0, row);
  }
  return result;
}
