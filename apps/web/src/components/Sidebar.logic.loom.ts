// loom: Loom's sidebar helpers, kept apart from upstream's Sidebar.logic.ts.
import {
  attentionLabel,
  type WorkstreamAttentionReason,
} from "@t3tools/client-runtime/state/loom/rollup";
import {
  hostedThreadIds,
  hostRowOf,
  isSubRow,
  presentationParentsOf,
} from "@t3tools/client-runtime/state/loom/sideThread";
import { sideThreadOf, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";

type SidebarShell = Pick<SidebarThreadSummary, "archivedAt" | "source">;

/** The row's top-status override for a Loom attention reason (theme tokens only). */
export function loomTopStatus(reason: WorkstreamAttentionReason) {
  return {
    label: attentionLabel(reason),
    icon: null,
    className: reason === "error" ? "text-error" : "text-warning-foreground",
  };
}

const liveParents = (threads: readonly SidebarShell[]) =>
  presentationParentsOf(
    threads.filter((thread) => thread.archivedAt === null).map((thread) => thread.source),
  );

/** The live threads whose host row is live: a side thread anchored on one nests as a sub-row. */
export const sidebarHostedThreadIds = (threads: readonly SidebarShell[]) =>
  hostedThreadIds(liveParents(threads));

/** The host row's thread for a route thread shown as a side-thread sub-row, else the thread itself. */
export function sidebarHostRowThreadId(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  threads: readonly (SidebarShell & Pick<SidebarThreadSummary, "id" | "environmentId">)[],
): ThreadId {
  const route = threads.find(
    (thread) => thread.id === threadId && thread.environmentId === environmentId,
  );
  if (route === undefined || sideThreadOf(route.source.workstream) === null) return threadId;
  const parents = liveParents(threads.filter((thread) => thread.environmentId === environmentId));
  return isSubRow(route.source, hostedThreadIds(parents)) ? hostRowOf(threadId, parents) : threadId;
}
