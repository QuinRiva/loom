/**
 * loom: the side-thread sub-rows each sidebar host row carries (plans/side-thread-class/plan.mdx §4).
 * One host map per environment snapshot; each host row selects its entry and re-renders only when
 * that entry's content changes, as `rollupAtom` does.
 */
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  hostedThreadIds,
  hostRowOf,
  isSubRow,
  presentationParentsOf,
} from "@t3tools/client-runtime/state/loom/sideThread";
import {
  sideThreadOf,
  type EnvironmentId,
  type SideThreadRole,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { isRunning } from "../lib/workstreamPresentation";
import { loomEnvironmentSnapshotAtom } from "../state/threads";

export interface SideThreadRowModel {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly role: SideThreadRole;
  readonly running: boolean;
}

const EMPTY_HOSTS: ReadonlyMap<ThreadId, readonly SideThreadRowModel[]> = new Map();
const EMPTY_ROWS: readonly SideThreadRowModel[] = [];

const rowsByHostAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const threads = get(loomEnvironmentSnapshotAtom(environmentId))?.threads;
    if (!threads) return EMPTY_HOSTS;
    const live = threads.filter((thread) => thread.archivedAt === null);
    const parents = presentationParentsOf(live);
    const hosted = hostedThreadIds(parents);
    const byHost = new Map<ThreadId, SideThreadRowModel[]>();
    for (const { thread, side } of live
      .flatMap((thread) => {
        const side = sideThreadOf(thread.workstream);
        return side !== null && isSubRow(thread, hosted) ? [{ thread, side }] : [];
      })
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.thread.createdAt) -
          DateTime.toEpochMillis(right.thread.createdAt),
      )) {
      const host = hostRowOf(thread.id, parents);
      byHost.set(host, [
        ...(byHost.get(host) ?? []),
        {
          threadId: thread.id,
          title: thread.title,
          role: side.role,
          running: isRunning({ activity: thread.activityRunStatus ?? null }),
        },
      ]);
    }
    return byHost;
  }).pipe(Atom.withLabel(`loom-side-thread-hosts:${environmentId}`)),
);

/** The sub-rows under one host row (a scoped thread key); a stable array until its content changes. */
export const sideThreadRowsAtom = Atom.family((hostThreadKey: string) => {
  const ref = parseScopedThreadKey(hostThreadKey);
  let previous = EMPTY_ROWS;
  let previousKey = "[]";
  return Atom.make((get) => {
    const rows =
      ref === null
        ? EMPTY_ROWS
        : (get(rowsByHostAtom(ref.environmentId)).get(ref.threadId) ?? EMPTY_ROWS);
    const key = JSON.stringify(rows);
    if (key !== previousKey) {
      previousKey = key;
      previous = rows;
    }
    return previous;
  }).pipe(Atom.withLabel(`loom-side-thread-rows:${hostThreadKey}`));
});
