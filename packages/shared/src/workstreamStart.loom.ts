import type { ThreadId } from "@t3tools/contracts";

export interface StartNode {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly held: boolean;
  readonly outcome: "done" | "cancelled" | null;
  readonly kickoffAt: string | null;
  readonly kickoffBriefPath: string | null;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}

export const dependenciesSatisfied = (node: StartNode, byId: ReadonlyMap<ThreadId, StartNode>) =>
  node.blockedBy.every((id) => byId.get(id)?.outcome === "done");

/** The one start rule: dispatcher promotion, first-turn gate and the board's "ready" column all read this. */
export const isEligibleToStart = (node: StartNode, byId: ReadonlyMap<ThreadId, StartNode>) =>
  node.parentThreadId !== null &&
  node.archivedAt === null &&
  node.deletedAt === null &&
  !node.held &&
  node.outcome === null &&
  node.kickoffAt === null &&
  node.kickoffBriefPath !== null &&
  dependenciesSatisfied(node, byId);
