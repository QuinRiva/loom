import type { ThreadId } from "@t3tools/contracts";
import { areDependenciesSatisfied } from "./workstreamDependencies.ts";

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

/**
 * One dependency rule (DL-211): only a known same-parent sibling whose outcome is not `done`
 * gates. Pass a sibling map that includes archived rows — an archived `done` dependency still
 * releases; a deleted (absent) one never gates.
 */
export const dependenciesSatisfied = (node: StartNode, byId: ReadonlyMap<ThreadId, StartNode>) =>
  areDependenciesSatisfied(node, byId);

/** The one start rule: dispatcher promotion, first-turn gate and the graph's "ready" column all read this. */
export const isEligibleToStart = (node: StartNode, byId: ReadonlyMap<ThreadId, StartNode>) =>
  node.parentThreadId !== null &&
  node.archivedAt === null &&
  node.deletedAt === null &&
  !node.held &&
  node.outcome === null &&
  node.kickoffAt === null &&
  node.kickoffBriefPath !== null &&
  dependenciesSatisfied(node, byId);

/**
 * An un-started child whose every start gate is clear except the brief:
 * exactly `isEligibleToStart` with the brief gate inverted, so the two sets
 * partition the startable children into promotable and brief-needed. The
 * dispatcher's brief-needed notice and the web's derived attention both read it.
 */
export const isBriefNeeded = (node: StartNode, byId: ReadonlyMap<ThreadId, StartNode>) =>
  node.parentThreadId !== null &&
  node.archivedAt === null &&
  node.deletedAt === null &&
  !node.held &&
  node.outcome === null &&
  node.kickoffAt === null &&
  node.kickoffBriefPath === null &&
  dependenciesSatisfied(node, byId);
