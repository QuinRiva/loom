/**
 * The deadlock notice (V1 issue #280), ported with logic unchanged minus the
 * fan-in clauses: every unfinished child of a parent is not held, not started
 * and waiting on another stuck sibling, so only re-planning the graph can
 * release one. `deadlockedNodes` (shared with the board's badge) decides; this
 * module keys the episode and composes the text.
 *
 * @module loom/orchestration/dispatcher/deadlock
 */
import type { LoomThreadWorkstream, ThreadId } from "@t3tools/contracts";
import {
  type DependencyGateThread,
  describeUnsatisfiedDependency,
} from "@t3tools/shared/workstreamDependencies";
import * as NodeCrypto from "node:crypto";

import { WORKSTREAM_CONTROL_PLANE_MARKER } from "./wakes.ts";

/**
 * The deadlock episode for `deadlockCommandId`: a hash over the stuck
 * children's ids and STABLE transition stamps (outcome, hold, dependency set) —
 * never `updatedAt` — so ticks leave it alone while any real graph change that
 * re-enters the state re-arms it.
 */
export const deadlockEpisode = (
  stuck: ReadonlyArray<
    Pick<LoomThreadWorkstream, "threadId" | "outcomeAt" | "heldSince" | "dependenciesSince">
  >,
): string =>
  NodeCrypto.createHash("sha256")
    .update(
      stuck
        .map((c) => `${c.threadId}:${c.outcomeAt}:${c.heldSince}:${c.dependenciesSince}`)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 24);

/** Composes the deadlock notice: every stuck child, what it waits on, and the ways out. */
export const buildDeadlockMessage = <
  T extends DependencyGateThread & { readonly role: string | null; readonly title?: string },
>(
  stuck: ReadonlyArray<T>,
  siblingsById: ReadonlyMap<ThreadId, T>,
): string =>
  [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    `Your workstream is deadlocked: ${stuck.length === 1 ? "your one unfinished sub-thread is" : `all ${stuck.length} of your unfinished sub-threads are`} unheld but none can start, and only re-planning the graph can change that. Each is waiting on:`,
    "",
    ...stuck.map(
      (child) =>
        `- ${child.role ?? "sub-thread"} \`${child.id}\`${child.title ? ` (“${child.title}”)` : ""}: ${describeUnsatisfiedDependency(child, siblingsById) ?? "waiting"}`,
    ),
    "",
    "A reviewer must not wait on work that waits on the thread it reviews. Ways out: re-point dependencies (`mcp__t3-code__workstream_set_dependencies`), dissolve a review gate (`mcp__t3-code__workstream_set_outcome` done on the reviewer — cancelling it would block the dependents that wait on it), or cancel nodes you no longer need.",
  ].join("\n");
