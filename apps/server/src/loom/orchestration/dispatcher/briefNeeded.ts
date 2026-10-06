/**
 * The brief-needed condition, its episode clock, its re-arming rung ladder and
 * the batched notice (V1 scaffold plan §2–§3, liveness plan §3.2–§3.3), ported
 * with logic unchanged onto the sidecar row. V1's `planned` hold is the `held`
 * flag, which no agent tool writes in pull 9, so the notice's deliberate-deferral
 * move is a dependency on the work the brief waits for; fan-in gaps are gone.
 *
 * @module loom/orchestration/dispatcher/briefNeeded
 */
import type { LoomThreadWorkstream, ThreadId } from "@t3tools/contracts";
import { dependenciesSatisfied, type StartNode } from "@t3tools/shared/workstreamStart.loom";
import * as NodeCrypto from "node:crypto";

import { formatStalledFor, WORKSTREAM_CONTROL_PLANE_MARKER } from "./wakes.ts";

/** The row shape the brief-needed predicates read: a start node plus the stable stamps the clock uses. */
export type BriefNeededNode = StartNode &
  Pick<LoomThreadWorkstream, "createdAt" | "dependenciesSince" | "outcomeAt" | "lastOutcome">;

/**
 * An un-started child whose every start gate is clear except the brief:
 * exactly `isEligibleToStart` with the brief gate inverted, so the two sets
 * partition the startable children into promotable and brief-needed.
 */
export const isBriefNeeded = <T extends BriefNeededNode>(
  node: T,
  siblingsById: ReadonlyMap<ThreadId, T>,
): boolean =>
  node.parentThreadId !== null &&
  node.archivedAt === null &&
  node.deletedAt === null &&
  !node.held &&
  node.outcome === null &&
  node.kickoffAt === null &&
  node.kickoffBriefPath === null &&
  dependenciesSatisfied(node, siblingsById);

const parseIsoMs = (iso: string | null | undefined): number =>
  iso === null || iso === undefined ? Number.NaN : Date.parse(iso);

/**
 * The brief-needed episode clock (ms): the latest stable transition that made
 * the node eligible — its creation, a `dependencies.set` that re-entered
 * eligibility (only while the current set is satisfied), or a same-parent
 * dependency reaching `done` (its submit or its outcome-set). Never `updatedAt`,
 * which drifts and would re-arm the notice in a loop.
 */
export const briefNeededSinceMs = <T extends BriefNeededNode>(
  node: T,
  siblingsById: ReadonlyMap<ThreadId, T>,
): number => {
  const candidates = [
    parseIsoMs(node.createdAt),
    dependenciesSatisfied(node, siblingsById) ? parseIsoMs(node.dependenciesSince) : Number.NaN,
    ...node.blockedBy.flatMap((depId) => {
      const dep = depId === node.id ? undefined : siblingsById.get(depId);
      return dep === undefined || dep.parentThreadId !== node.parentThreadId
        ? []
        : [
            parseIsoMs(dep.lastOutcome?.at),
            dep.outcome === "done" ? parseIsoMs(dep.outcomeAt) : Number.NaN,
          ];
    }),
  ].filter((ms) => !Number.isNaN(ms));
  return candidates.length === 0 ? 0 : Math.max(...candidates);
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The re-arming ladder over the episode age: rung 0 immediately, 1 at ≥ 1 h,
 * 2 at ≥ 6 h, then one per day. Only the current rung is dispatched, so
 * downtime never backfills a burst.
 */
export const rungFor = (ageMs: number): number =>
  ageMs < HOUR_MS ? 0 : ageMs < 6 * HOUR_MS ? 1 : 2 + Math.floor(ageMs / DAY_MS);

/**
 * The rung key for `briefNeededCommandId`: a hash over the batch's
 * `(child, episode, rung)` triples, so a fresh episode or a crossed rung
 * re-arms the parent's notice and nothing else does.
 */
export const briefNeededRungKey = (
  entries: ReadonlyArray<{
    readonly childId: ThreadId;
    readonly sinceMs: number;
    readonly rung: number;
  }>,
): string =>
  NodeCrypto.createHash("sha256")
    .update(
      entries
        .map((entry) => `${entry.childId}:${entry.sinceMs}:${entry.rung}`)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 24);

/** How long a node may sit brief-needed before its parent carries a derived `needs_guidance` for a human. */
export const BRIEF_NEEDED_ATTENTION_MS = DAY_MS;

/**
 * Parents with a child brief-needed for at least `BRIEF_NEEDED_ATTENTION_MS` —
 * derived at the read boundary (never stored), so it self-clears the moment the
 * node is briefed, held or finished.
 */
export const briefNeededAttentionParentIds = <T extends BriefNeededNode>(
  nodes: Iterable<T>,
  siblingsById: ReadonlyMap<ThreadId, T>,
  nowMs: number,
): ReadonlySet<ThreadId> =>
  new Set(
    [...nodes]
      .filter(
        (node) =>
          isBriefNeeded(node, siblingsById) &&
          nowMs - briefNeededSinceMs(node, siblingsById) >= BRIEF_NEEDED_ATTENTION_MS,
      )
      .map((node) => node.parentThreadId!),
  );

/**
 * The ONE batched notice naming every brief-needed child of a parent by graph
 * key (else thread id), role and title, with the three sanctioned moves — the
 * moment the parent holds the upstream reports the brief should build on.
 */
export const buildBriefNeededMessage = (
  children: ReadonlyArray<{
    readonly id: ThreadId;
    readonly graphKey: string | null;
    readonly role: string | null;
    readonly title: string;
    /** Age of the episode; rendered once past the first rung. */
    readonly ageMs: number;
    readonly rung: number;
  }>,
): string =>
  [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    children.length === 1
      ? "One of your Workstream sub-threads is scaffolded and unblocked (its dependencies are satisfied and it is not held) but has NO kickoff brief yet, so it cannot launch:"
      : `${children.length} of your Workstream sub-threads are scaffolded and unblocked (dependencies satisfied, not held) but have NO kickoff brief yet, so they cannot launch:`,
    "",
    ...children.map((child) => {
      const handle =
        child.graphKey !== null ? `\`${child.graphKey}\` (\`${child.id}\`)` : `\`${child.id}\``;
      const stalled = child.rung > 0 ? ` — stalled ${formatStalledFor(child.ageMs)}` : "";
      return `- ${handle} — ${child.role ?? "child"}: ${child.title}${stalled}`;
    }),
    "",
    "Pick one of three moves for each node — while it stays in this state you will keep hearing about it, on a widening schedule (1h, 6h, then daily):",
    "",
    "1. **Brief it now** — `mcp__t3-code__workstream_brief` (node = its graph key or thread id); it launches as soon as the brief lands. This is the moment to write it: any upstream results it should build on are now in hand.",
    "2. **Defer it deliberately** — `mcp__t3-code__workstream_set_dependencies`, adding the sibling whose result the brief must wait for. That takes the node out of the brief-needed state and stops these notices until the sibling is `done`.",
    "3. **Cancel it** — `mcp__t3-code__workstream_set_outcome` cancelled, if the node is no longer wanted.",
    "",
    "Leaving it untouched is not a fourth option: the graph is stalled at this node either way, and silence is indistinguishable from having forgotten it.",
  ].join("\n");
