/**
 * loom: the receipts spliced into a thread's timeline, from the V2 shell alone so they survive a
 * reload: per `/handoff` drafter forked from this thread (its `handoffDestinations` once archived),
 * `goal_handoff` marker and continuing root; and per exchange a query thread promoted. Rows are
 * inserted, not sorted.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  HANDOFF_DRAFTER_ROLE,
  type LoomThreadShellFields,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import type { MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { loomEnvironmentSnapshotAtom } from "~/state/threads";

export type LoomHandoffState = "staged" | "launched" | "done" | "cancelled";
export type LoomReceiptState = "waiting" | "drafting" | "failed" | "handed-off";

export interface LoomHandoffDestination {
  readonly threadId: ThreadId;
  /** Null when the destination is not in the snapshot (older settled, archived, deleted). */
  readonly title: string | null;
  readonly state: LoomHandoffState | null;
}

export interface LoomTimelineRow {
  readonly kind: "loom-handoff";
  readonly id: string;
  readonly createdAt: string;
  readonly sourceThreadId: ThreadId;
  readonly state: LoomReceiptState;
  /** The `/handoff` drafter; null for the thread's own `goal_handoff` / `goal_continue`. */
  readonly drafterThreadId: ThreadId | null;
  /** The human's `/handoff` explanation (the drafter's purpose) while the drafter is live. */
  readonly explanation: string | null;
  readonly destinations: ReadonlyArray<LoomHandoffDestination>;
}

/** A query thread's promoted exchange: the comment waits in the author's composer. */
export interface LoomPromotionRow {
  readonly kind: "loom-promotion";
  readonly id: string;
  readonly createdAt: string;
  readonly sourceThreadId: ThreadId;
  readonly authorThreadId: ThreadId;
}

const EMPTY_ROWS: ReadonlyArray<LoomTimelineRow | LoomPromotionRow> = Object.freeze([]);

const handoffState = (workstream: LoomThreadShellFields): LoomHandoffState =>
  workstream.outcome ?? (workstream.held ? "staged" : "launched");

/** Every receipt row of `sourceId`, oldest first (also the toast coordinator's input). */
export function handoffReceiptRows(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  sourceId: ThreadId,
): ReadonlyArray<LoomTimelineRow> {
  const source = threads.find((thread) => thread.id === sourceId);
  const destination = (threadId: ThreadId): LoomHandoffDestination => {
    const shell = threads.find((thread) => thread.id === threadId);
    return {
      threadId,
      title: shell?.title ?? null,
      state: shell?.workstream ? handoffState(shell.workstream) : null,
    };
  };
  const row = (
    key: ThreadId,
    fields: Omit<LoomTimelineRow, "kind" | "id" | "sourceThreadId">,
  ): LoomTimelineRow => ({
    kind: "loom-handoff",
    id: `loom-handoff:${key}`,
    sourceThreadId: sourceId,
    ...fields,
  });
  const markers = (source?.workstream?.handoffDestinations ?? []).flatMap((marker) =>
    marker.createdAt === null ? [] : [{ ...marker, createdAt: marker.createdAt }],
  );
  const drafters = threads.filter(
    (thread) =>
      thread.workstream?.role === HANDOFF_DRAFTER_ROLE &&
      thread.workstream.forkFromThreadId === sourceId,
  );
  const liveDrafterIds = new Set(drafters.map((drafter) => drafter.id));
  // A settled drafter is archived out of the snapshot: its markers carry the row.
  const settled = new Map<ThreadId, typeof markers>();
  for (const marker of markers) {
    const drafterId = marker.drafterThreadId;
    if (drafterId === null || drafterId === sourceId || liveDrafterIds.has(drafterId)) continue;
    settled.set(drafterId, [...(settled.get(drafterId) ?? []), marker]);
  }
  return [
    ...drafters.map((drafter) => {
      // The drafter's own markers: what the reactor settles on (the source's copy is best-effort).
      const placed = drafter.workstream!.handoffDestinations.filter(
        (marker) => marker.drafterThreadId === drafter.id,
      );
      const ended = drafter.latestRunId !== null && drafter.activityRunStatus == null;
      return row(drafter.id, {
        createdAt: DateTime.formatIso(drafter.createdAt),
        state:
          ended && placed.length > 0
            ? "handed-off"
            : ended || drafter.workstream!.attention.length > 0
              ? "failed"
              : // Sent mid-turn: the drafter forks once this thread's turn ends.
                drafter.workstream!.kickoffAt === null
                ? "waiting"
                : "drafting",
        drafterThreadId: drafter.id,
        explanation: drafter.workstream!.purpose,
        destinations: placed.map((marker) => destination(marker.threadId)),
      });
    }),
    ...[...settled].map(([drafterId, placed]) =>
      row(drafterId, {
        createdAt: placed[0]!.createdAt,
        state: "handed-off",
        drafterThreadId: drafterId,
        explanation: null,
        destinations: placed.map((marker) => destination(marker.threadId)),
      }),
    ),
    ...markers
      .filter((marker) => marker.drafterThreadId === null || marker.drafterThreadId === sourceId)
      .map((marker) =>
        row(marker.threadId, {
          createdAt: marker.createdAt,
          state: "handed-off",
          drafterThreadId: null,
          explanation: null,
          destinations: [destination(marker.threadId)],
        }),
      ),
    ...threads
      .filter(
        (thread) =>
          thread.workstream?.continuesThreadId === sourceId &&
          thread.lineage.parentThreadId === null,
      )
      .map((thread) =>
        row(thread.id, {
          createdAt: DateTime.formatIso(thread.createdAt),
          state: "handed-off",
          drafterThreadId: null,
          explanation: null,
          destinations: [destination(thread.id)],
        }),
      ),
  ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function promotionReceiptRows(
  source: OrchestrationV2ThreadShell | undefined,
): ReadonlyArray<LoomPromotionRow> {
  const authorThreadId = source?.workstream?.forkFromThreadId;
  return source && authorThreadId
    ? (source.workstream?.documentQuery?.promotions ?? []).map((promotion) => ({
        kind: "loom-promotion",
        id: `loom-promotion:${promotion.promotionId}`,
        createdAt: promotion.promotedAt,
        sourceThreadId: source.id,
        authorThreadId,
      }))
    : [];
}

const loomRowsAtom = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  let previous = EMPTY_ROWS;
  let previousKey = "";
  return Atom.make((get) => {
    const threads =
      ref === null ? null : get(loomEnvironmentSnapshotAtom(ref.environmentId))?.threads;
    if (!ref || !threads) return EMPTY_ROWS;
    const rows = [
      ...handoffReceiptRows(threads, ref.threadId),
      ...promotionReceiptRows(threads.find((thread) => thread.id === ref.threadId)),
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

export function useLoomTimelineRows(
  threadKey: string,
): ReadonlyArray<LoomTimelineRow | LoomPromotionRow> {
  return useAtomValue(loomRowsAtom(threadKey));
}

export function insertLoomTimelineRows(
  rows: MessagesTimelineRow[],
  loomRows: ReadonlyArray<LoomTimelineRow | LoomPromotionRow>,
): MessagesTimelineRow[] {
  if (loomRows.length === 0) return rows;
  const result = [...rows];
  for (const row of loomRows) {
    // A promotion is recorded mid-turn, so it waits for the turn's reply: before the next human message.
    const index = result.findIndex(
      (candidate) =>
        candidate.createdAt !== null &&
        candidate.createdAt > row.createdAt &&
        (row.kind !== "loom-promotion" ||
          (candidate.kind === "message" && candidate.message.role === "user")),
    );
    const at = index !== -1 ? index : result.findIndex((candidate) => candidate.kind === "working");
    result.splice(at === -1 ? result.length : at, 0, row);
  }
  return result;
}
