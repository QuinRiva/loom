/**
 * The dispatcher's wake rails (Phase 3 plan "Wake tiers, ids and modes"), V1's
 * `collectTerminalDeltas` … `surfaceDeferredWakes` re-expressed on the V2
 * pass. Decision-bearing wakes (attention, yield, brief-needed, deadlock,
 * notify) are `steered`; the digest is `fyi`. Every id is deterministic, so a
 * receipt makes each episode exactly-once; "already told" for the per-item FYI
 * rails is read back from the parent's stored control messages
 * (`PassContext.delivered`), never from dispatcher state. No rail clears a hold.
 *
 * @module loom/orchestration/dispatcher/rails
 */
import {
  CommandId,
  type ControlPayloadItem,
  DEFAULT_GATE_MAX_ROUNDS,
  type LoomAttentionReason,
  type LoomThreadWorkstream,
  type ThreadId,
} from "@t3tools/contracts";
import { deadlockedNodes } from "@t3tools/shared/workstreamDependencies";
import { isMemberOfUnresolvedGate } from "@t3tools/shared/workstreamGraph";
import { isBriefNeeded } from "@t3tools/shared/workstreamStart.loom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import { readWorkstreamReportAt } from "../../workstream/report.ts";
import {
  briefNeededRungKey,
  briefNeededSinceMs,
  buildBriefNeededMessage,
  rungFor,
} from "./briefNeeded.ts";
import {
  attentionCommandId,
  briefNeededCommandId,
  controlMessage,
  deadlockCommandId,
  digestCommandId,
  notifyCommandId,
  notifyExpireCommandId,
  notifyMarkCommandId,
  wakeDeferredCommandId,
  wakeNotification,
  yieldCommandId,
} from "./controlMessage.ts";
import { buildDeadlockMessage, deadlockEpisode } from "./deadlock.ts";
import {
  buildDigestPayload,
  buildDigestPiggyback,
  buildStandaloneDigest,
  digestEpisodeHash,
  digestItems,
  digestShouldFlush,
  FYI_DIGEST_FLUSH_MS,
  parentWorkstreamQuiet,
  renderDeadEpisodeDigestLine,
  renderRecoveredDigestLine,
  terminalEpisodeKey,
} from "./digest.ts";
import { boundedExcerpt, buildChildWakeMessage, workstreamLane } from "./wakes.ts";
import {
  type DeliveredItem,
  landed,
  type PassContext,
  type PassStep,
  type PendingDigestItem,
  type WorkstreamNode,
} from "./WorkstreamDispatcher.ts";
import { buildYieldPayload, buildYieldWakeMessage, type YieldGateContext } from "./yield.ts";

/** Attention reasons whose raise steers a notice to the parent; `awaiting_orchestrator` is the yield rail's. */
export const ATTENTION_NOTICE_REASONS = [
  "needs_guidance",
  "awaiting_acceptance",
  "error",
] as const satisfies ReadonlyArray<LoomAttentionReason>;

/**
 * Brief-needed and deadlock wait this long for a BUSY parent (V1 deferred them
 * until idle): the parent is usually mid-scaffold or mid-replan, and a steer
 * then is noise; an idle parent hears at once.
 */
export const PARENT_BUSY_GRACE_MS = 600_000;

/** How long a busy parent may show no activity while FYI wakes wait on it before a human is pulled in (V1 #304). */
export const DEFERRED_WAKE_SILENCE_MS = 600_000;

const nowMs = (ctx: PassContext) => DateTime.toEpochMillis(ctx.now);
const createdAt = (ctx: PassContext) => DateTime.formatIso(ctx.now);
const nodeOf = (ctx: PassContext, row: LoomThreadWorkstream) => ctx.nodesById.get(row.threadId)!;
const siblingNodes = (ctx: PassContext, parentId: ThreadId) =>
  ctx.rows.filter((row) => row.parentThreadId === parentId).map((row) => nodeOf(ctx, row));
/** A parent that can take an FYI wake: present, not archived, not finished. */
const fyiParent = (ctx: PassContext, parentId: ThreadId) =>
  ctx.shells.get(parentId)?.archivedAt === null &&
  (ctx.nodesById.get(parentId)?.outcome ?? null) === null;
const parentIdleOrPastGrace = (ctx: PassContext, parentId: ThreadId, onsetMs: number) =>
  ctx.shells.get(parentId)?.activityRunStatus == null ||
  nowMs(ctx) - onsetMs >= PARENT_BUSY_GRACE_MS;
const readReport = (path: string | null) =>
  path === null ? Effect.succeed(null) : Effect.map(readWorkstreamReportAt(path), Option.getOrNull);

/**
 * A delivered item that told the parent how its child stands: a `terminal` /
 * `gate-resolved` / `recovered` digest item (standalone or piggybacked), a
 * yield card or an attention notice.
 */
const isStatusWord = ({ payload, item }: DeliveredItem) =>
  item.kind === "terminal" ||
  item.kind === "gate-resolved" ||
  item.kind === "recovered" ||
  (item.kind === undefined && (payload.kind === "yield" || payload.notice === "attention"));

/** The parent was told how `threadId` ended, at or after `sinceMs`. */
const toldAbout = (delivered: ReadonlyArray<DeliveredItem>, threadId: ThreadId, sinceMs: number) =>
  delivered.some(
    (word) => word.item.threadId === threadId && word.atMs >= sinceMs && isStatusWord(word),
  );

const stash = (ctx: PassContext, parentId: ThreadId, item: PendingDigestItem) =>
  ctx.pendingDigests.set(parentId, [...(ctx.pendingDigests.get(parentId) ?? []), item]);

const splitPending = (items: ReadonlyArray<PendingDigestItem>) => ({
  members: items.flatMap((item) => (item.member === undefined ? [] : [item.member])),
  extras: items.flatMap((item) => (item.extra === undefined ? [] : [item.extra])),
});

/** Forgets items a message just carried. */
const settle = (ctx: PassContext, parentId: ThreadId, items: ReadonlyArray<PendingDigestItem>) => {
  for (const item of items) item.settle?.();
  ctx.pendingDigests.set(
    parentId,
    (ctx.pendingDigests.get(parentId) ?? []).filter((pending) => !items.includes(pending)),
  );
};

/** The parent's withheld FYI items as a piggyback (text after the action copy, items after the wake's own). */
const piggybackFor = (ctx: PassContext, parentId: ThreadId) => {
  const pending = ctx.pendingDigests.get(parentId) ?? [];
  const { members, extras } = splitPending(pending);
  return {
    pending,
    members,
    extras,
    text: pending.length === 0 ? "" : `\n${buildDigestPiggyback(members, extras)}`,
    items: digestItems(members, extras),
  };
};

const childItem = (
  child: LoomThreadWorkstream,
  report: string | null,
  title: string,
  status: string,
): ControlPayloadItem => {
  const excerpt = boundedExcerpt(report);
  return {
    threadId: child.threadId,
    ...(child.role !== null ? { role: child.role } : {}),
    title,
    status,
    ...(child.reportPath !== null ? { reportPath: child.reportPath } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
  };
};

/**
 * Terminal deltas → FYI items: a child with a recorded submit (`lastOutcome.eventId`)
 * and an outcome the parent has not heard of since that submit, held back while
 * it is a party of an unresolved gate (a resolved pair reports together as one
 * `gate-resolved` item plus the coder's reference) — or as `recovered` when the
 * parent last heard of it through an `error` notice; plus dead episodes and the
 * liveness advisories. Imported rows (null stamps) never qualify.
 */
export const terminalDeltas: PassStep = {
  name: "terminalDeltas",
  run: Effect.fn("loom.dispatcher.terminalDeltas")(function* (ctx: PassContext) {
    for (const child of ctx.rows) {
      const parentId = child.parentThreadId;
      const lastOutcome = child.lastOutcome;
      if (parentId === null || child.outcome === null || lastOutcome?.eventId == null) continue;
      if (!fyiParent(ctx, parentId)) continue;
      const siblings = siblingNodes(ctx, parentId);
      if (isMemberOfUnresolvedGate(nodeOf(ctx, child), siblings)) continue;
      const sinceMs = Date.parse(lastOutcome.at);
      const delivered = yield* ctx.delivered(parentId);
      if (toldAbout(delivered, child.threadId, sinceMs)) continue;
      // V1's `recovered`: when the parent's last word on this child was its `error`
      // notice, a `done` supersedes that alarm instead of reporting one more completion.
      const lastWord = delivered.findLast(
        (word) =>
          word.item.threadId === child.threadId && word.atMs < sinceMs && isStatusWord(word),
      );
      if (
        child.outcome === "done" &&
        lastWord?.payload.notice === "attention" &&
        lastWord.item.status === "error"
      ) {
        stash(ctx, parentId, {
          key: terminalEpisodeKey(child),
          eventAtMs: sinceMs,
          extra: {
            kind: "recovered",
            line: renderRecoveredDigestLine({
              ...child,
              id: child.threadId,
              eventAt: lastOutcome.at,
            }),
            childId: child.threadId,
            role: child.role,
          },
        });
        continue;
      }
      const resolvedRoute =
        lastOutcome.decision === "resolve" && child.lastRoute?.kind === "resolve"
          ? child.lastRoute
          : null;
      // A resolved gate reports once both members are done, as one pair.
      if (resolvedRoute !== null && ctx.nodesById.get(resolvedRoute.to)?.outcome === null) continue;
      stash(ctx, parentId, {
        key: resolvedRoute?.eventId ?? terminalEpisodeKey(child),
        eventAtMs: sinceMs,
        member: {
          id: child.threadId,
          role: child.role,
          outcome: child.outcome,
          attention: child.attention,
          reportPath: child.reportPath,
          report: yield* readReport(child.reportPath),
          lastOutcome,
          gateRounds: child.gateRounds,
          routes: child.routes,
          eventAt: lastOutcome.at,
          releasedDependents:
            child.outcome === "done"
              ? siblings
                  .filter((other) => other.blockedBy.includes(child.threadId))
                  .map((other) => ({ id: other.id, role: other.role }))
              : [],
        },
      });
    }
    // A rejected `server:` command: its thread's parent is the only actor left.
    for (const dead of ctx.deadEpisodes) {
      const owner = ctx.nodesById.get(dead.threadId);
      const forget = () => ctx.deadEpisodes.delete(dead);
      if (owner?.parentThreadId == null) {
        forget();
        continue;
      }
      stash(ctx, owner.parentThreadId, {
        key: dead.commandId,
        eventAtMs: dead.atMs,
        extra: {
          kind: "dead-episode",
          line: renderDeadEpisodeDigestLine(dead),
          childId: dead.threadId,
          role: owner.role,
        },
        settle: forget,
      });
    }
    for (const [parentId, byKey] of ctx.advisories) {
      const delivered = yield* ctx.delivered(parentId);
      for (const [key, advice] of byKey) {
        const sinceMs = Date.parse(advice.episodeStartedAt);
        const told = delivered.some(
          ({ item, atMs }) =>
            item.threadId === advice.item.threadId &&
            item.kind === advice.item.kind &&
            atMs >= sinceMs,
        );
        if (told) {
          byKey.delete(key);
          continue;
        }
        stash(ctx, parentId, {
          key,
          eventAtMs: sinceMs,
          extra: {
            kind: advice.item.kind,
            line: `- ${advice.item.excerpt ?? advice.item.title}`,
            childId: advice.item.threadId,
            role: advice.item.role ?? null,
          },
          settle: () => byKey.delete(key),
        });
      }
    }
  }),
};

/**
 * The attention rail: one steered notice to the parent per raise episode of
 * `needs_guidance`, `awaiting_acceptance` or `error` on a child, keyed on
 * `attentionEpisodes[reason]` (no stamp — an imported row — no notice).
 */
export const attentionRail: PassStep = {
  name: "attention",
  run: Effect.fn("loom.dispatcher.attention")(function* (ctx: PassContext) {
    for (const child of ctx.rows) {
      const parentId = child.parentThreadId;
      if (parentId === null || !ctx.shells.has(parentId)) continue;
      for (const reason of ATTENTION_NOTICE_REASONS) {
        const episode = child.attention.includes(reason)
          ? child.attentionEpisodes[reason]
          : undefined;
        if (episode === undefined) continue;
        const id = attentionCommandId(child.threadId, reason, episode);
        if (yield* ctx.sent(id)) continue;
        const report = yield* readReport(child.reportPath);
        const piggyback = piggybackFor(ctx, parentId);
        const outcome = yield* ctx.dispatch(
          "attention",
          controlMessage({
            threadId: parentId,
            id,
            tier: "steered",
            origin: "control_notice",
            text:
              buildChildWakeMessage(
                {
                  ...child,
                  id: child.threadId,
                  lane: workstreamLane(nodeOf(ctx, child), ctx.nodesById),
                },
                reason === "error" ? "error" : "attention",
                report,
              ) + piggyback.text,
            payload: {
              kind: "notice",
              notice: "attention",
              heading: `A sub-thread needs attention (${reason}).`,
              items: [
                childItem(child, report, `Needs attention — \`${reason}\``, reason),
                ...piggyback.items,
              ],
            },
          }),
        );
        if (landed(outcome)) settle(ctx, parentId, piggyback.pending);
      }
    }
  }),
};

/**
 * The yield rail: a child holding `awaiting_orchestrator` with a recorded
 * submit wakes its parent once per submit (`lastOutcome.eventId`) with its
 * report and the decision menu — steered, so a running parent hears it
 * mid-turn. The child's flag stands until the parent acts.
 */
export const yieldRail: PassStep = {
  name: "yields",
  run: Effect.fn("loom.dispatcher.yields")(function* (ctx: PassContext) {
    for (const child of ctx.rows) {
      const parentId = child.parentThreadId;
      const lastOutcome = child.lastOutcome;
      if (
        parentId === null ||
        !ctx.shells.has(parentId) ||
        !child.attention.includes("awaiting_orchestrator") ||
        lastOutcome?.eventId == null
      )
        continue;
      const id = yieldCommandId(child.threadId, lastOutcome.eventId);
      if (yield* ctx.sent(id)) continue;
      const report = yield* readReport(child.reportPath);
      const yielding = { id: child.threadId, role: child.role, reportPath: child.reportPath };
      let gate: YieldGateContext | undefined;
      if (lastOutcome.decision === "cap-breach") {
        const loopRoute = child.routes.find((route) => route.kind === "loop" && route.to);
        const counterpart =
          loopRoute?.to === undefined ? undefined : ctx.nodesById.get(loopRoute.to);
        gate = {
          rounds: child.gateRounds,
          maxRounds: loopRoute?.maxRounds ?? DEFAULT_GATE_MAX_ROUNDS,
          counterpart:
            counterpart === undefined
              ? null
              : {
                  id: counterpart.id,
                  role: counterpart.role,
                  reportPath: counterpart.reportPath,
                  report: yield* readReport(counterpart.reportPath),
                },
        };
      }
      const flags = {
        synthesised: lastOutcome.synthesised === true,
        gateParked: isMemberOfUnresolvedGate(nodeOf(ctx, child), siblingNodes(ctx, parentId)),
      };
      const piggyback = piggybackFor(ctx, parentId);
      const outcome = yield* ctx.dispatch(
        "yield",
        controlMessage({
          threadId: parentId,
          id,
          tier: "steered",
          origin: "control_notice",
          text:
            buildYieldWakeMessage(yielding, lastOutcome.outcome, report, gate, flags) +
            piggyback.text,
          payload: buildYieldPayload(
            yielding,
            lastOutcome.outcome,
            report,
            gate,
            piggyback.pending.length === 0 ? undefined : piggyback,
            flags,
          ),
          notification: wakeNotification(
            `${child.role ?? "Sub-thread"} ${flags.synthesised ? "went quiet" : "yielded"}: ${child.threadId}`,
          ),
        }),
      );
      if (landed(outcome)) settle(ctx, parentId, piggyback.pending);
    }
  }),
};

/**
 * Brief-needed: one batched notice per parent naming every unblocked,
 * unbriefed child that owes a rung (1 h, 6 h, daily). A (child, episode, rung)
 * already named in a stored brief-needed notice is not named again.
 */
export const briefNeededRail: PassStep = {
  name: "briefNeeded",
  run: Effect.fn("loom.dispatcher.briefNeeded")(function* (ctx: PassContext) {
    const byParent = new Map<
      ThreadId,
      Array<{ readonly node: WorkstreamNode; readonly sinceMs: number; readonly rung: number }>
    >();
    for (const row of ctx.rows) {
      const node = nodeOf(ctx, row);
      if (row.parentThreadId === null || !isBriefNeeded(node, ctx.nodesById)) continue;
      const sinceMs = briefNeededSinceMs(node, ctx.nodesById);
      const rung = rungFor(Math.max(0, nowMs(ctx) - sinceMs));
      const told = (yield* ctx.delivered(row.parentThreadId)).some(
        ({ payload, item, atMs }) =>
          payload.notice === "brief-needed" &&
          item.kind === undefined &&
          item.threadId === row.threadId &&
          item.status === `rung-${rung}` &&
          atMs >= sinceMs,
      );
      if (!told)
        byParent.set(row.parentThreadId, [
          ...(byParent.get(row.parentThreadId) ?? []),
          { node, sinceMs, rung },
        ]);
    }
    for (const [parentId, entries] of byParent) {
      if (
        !fyiParent(ctx, parentId) ||
        !parentIdleOrPastGrace(ctx, parentId, Math.max(...entries.map((entry) => entry.sinceMs)))
      )
        continue;
      const children = entries.map(({ node, sinceMs, rung }) => ({
        id: node.id,
        graphKey: node.graphKey,
        role: node.role,
        title: ctx.shells.get(node.id)?.title ?? node.id,
        ageMs: Math.max(0, nowMs(ctx) - sinceMs),
        rung,
      }));
      const piggyback = piggybackFor(ctx, parentId);
      const outcome = yield* ctx.dispatch(
        "brief-needed",
        controlMessage({
          threadId: parentId,
          id: briefNeededCommandId(
            parentId,
            briefNeededRungKey(
              entries.map((e) => ({ childId: e.node.id, sinceMs: e.sinceMs, rung: e.rung })),
            ),
          ),
          tier: "steered",
          origin: "control_notice",
          text: buildBriefNeededMessage(children) + piggyback.text,
          payload: {
            kind: "notice",
            notice: "brief-needed",
            heading: "Sub-threads are waiting for a kickoff brief.",
            items: [
              ...children.map((child) => ({
                threadId: child.id,
                ...(child.role !== null ? { role: child.role } : {}),
                title: child.title,
                status: `rung-${child.rung}`,
              })),
              ...piggyback.items,
            ],
          },
        }),
      );
      if (landed(outcome)) settle(ctx, parentId, piggyback.pending);
    }
  }),
};

/**
 * Deadlock: a parent whose every unfinished child is unheld, unstarted and
 * waiting on another stuck sibling hears it once per episode — not while a
 * stuck child carries attention (that rail already spoke).
 */
export const deadlockRail: PassStep = {
  name: "deadlock",
  run: Effect.fn("loom.dispatcher.deadlock")(function* (ctx: PassContext) {
    const parents = new Set(
      ctx.rows.flatMap((row) => (row.parentThreadId === null ? [] : [row.parentThreadId])),
    );
    for (const parentId of parents) {
      if (!fyiParent(ctx, parentId)) continue;
      const stuck = deadlockedNodes(siblingNodes(ctx, parentId), ctx.nodesById);
      if (stuck === null || stuck.some((child) => child.attention.length > 0)) continue;
      const onsetMs = Math.max(
        ...stuck.map((child) => Date.parse(child.dependenciesSince ?? child.createdAt)),
      );
      if (!parentIdleOrPastGrace(ctx, parentId, onsetMs)) continue;
      const titled = stuck.map((child) => ({ ...child, title: ctx.shells.get(child.id)?.title }));
      const piggyback = piggybackFor(ctx, parentId);
      const outcome = yield* ctx.dispatch(
        "deadlock",
        controlMessage({
          threadId: parentId,
          id: deadlockCommandId(parentId, deadlockEpisode(stuck)),
          tier: "steered",
          origin: "control_notice",
          text: buildDeadlockMessage(titled, ctx.nodesById) + piggyback.text,
          payload: {
            kind: "notice",
            notice: "deadlock",
            heading: "Your workstream is deadlocked.",
            items: [
              ...titled.map((child) => ({
                threadId: child.id,
                ...(child.role !== null ? { role: child.role } : {}),
                title: child.title ?? child.id,
                status: "deadlocked",
              })),
              ...piggyback.items,
            ],
          },
        }),
      );
      if (landed(outcome)) settle(ctx, parentId, piggyback.pending);
    }
  }),
};

/**
 * The FYI digest: each parent's withheld items as ONE `start_if_idle` message
 * once its workstream is quiet or the oldest item is `FYI_DIGEST_FLUSH_MS` old.
 * A busy parent defers it (no receipt, recorded in `deferredWakes`); the next
 * pass recomputes the same items, so it lands once, coalesced, when idle.
 */
export const digestFlush: PassStep = {
  name: "digestFlush",
  run: Effect.fn("loom.dispatcher.digestFlush")(function* (ctx: PassContext) {
    for (const [parentId, items] of ctx.pendingDigests) {
      if (items.length === 0 || !fyiParent(ctx, parentId)) continue;
      const times = items.flatMap((item) => (item.eventAtMs === null ? [] : [item.eventAtMs]));
      const quiet = parentWorkstreamQuiet(
        parentId,
        ctx.rows.map((row) => ({ ...row, lane: workstreamLane(nodeOf(ctx, row), ctx.nodesById) })),
      );
      if (
        !digestShouldFlush({
          oldestEventAtMs: times.length === 0 ? null : Math.min(...times),
          now: nowMs(ctx),
          quiet,
          flushMs: FYI_DIGEST_FLUSH_MS,
        })
      )
        continue;
      const { members, extras } = splitPending(items);
      const outcome = yield* ctx.dispatch(
        "digest",
        controlMessage({
          threadId: parentId,
          id: digestCommandId(parentId, digestEpisodeHash(items.map((item) => item.key))),
          tier: "fyi",
          origin: "control_notice",
          text: buildStandaloneDigest(members, extras),
          payload: buildDigestPayload(members, extras),
          notification: wakeNotification(
            `FYI: ${items.length} workstream update${items.length === 1 ? "" : "s"}`,
          ),
        }),
        items.length,
      );
      if (landed(outcome)) settle(ctx, parentId, items);
    }
  }),
};

/**
 * Notify delivery: each pending `mcp__t3-code__notify_thread` record becomes one steered
 * message (origin `notify`) on its target — steered into a running turn,
 * started on an idle one — then is marked delivered. A target that finished
 * (read fresh: this pass may have reopened it) or refuses it expires the record.
 */
export const notifyDelivery: PassStep = {
  name: "notifyDelivery",
  run: Effect.fn("loom.dispatcher.notifyDelivery")(function* (ctx: PassContext) {
    const loomStore = yield* LoomStoreV2;
    for (const record of yield* loomStore.peerMessages.listPending()) {
      const sender = {
        threadId: record.senderThreadId,
        createdAt: createdAt(ctx),
        recordId: record.recordId,
      };
      const target = yield* loomStore.getWorkstream(record.targetThreadId);
      const outcome =
        target?.outcome != null
          ? null
          : yield* ctx.dispatch(
              "notify",
              controlMessage({
                threadId: record.targetThreadId,
                id: notifyCommandId(record.recordId),
                tier: "steered",
                origin: "notify",
                text: record.framedMessage,
                payload: {
                  kind: "notice",
                  notice: "notify",
                  heading: "A message from another thread.",
                  items: [
                    {
                      threadId: record.senderThreadId,
                      title: `From ${ctx.shells.get(record.senderThreadId)?.title ?? record.senderThreadId}`,
                    },
                  ],
                },
              }),
            );
      if (outcome?.status === "deferred") continue;
      const delivered = outcome !== null && landed(outcome);
      yield* ctx.dispatch(
        "notify",
        delivered
          ? {
              type: "thread.peer-message.mark-delivered",
              commandId: CommandId.make(notifyMarkCommandId(record.recordId)),
              ...sender,
            }
          : {
              type: "thread.peer-message.expire",
              commandId: CommandId.make(notifyExpireCommandId(record.recordId)),
              ...sender,
            },
      );
    }
  }),
};

/**
 * Deferred-wake visibility (V1 #304): a thread that FYI wakes waited on this
 * pass, that reads busy at pass start yet shows no activity for
 * `DEFERRED_WAKE_SILENCE_MS` and has nothing running, is wrongly busy — raise
 * `needs_guidance` on it once per silence episode (the silence start is the key).
 */
export const surfaceDeferredWakes: PassStep = {
  name: "deferredWakes",
  run: Effect.fn("loom.dispatcher.deferredWakes")(function* (ctx: PassContext) {
    const orchestrator = yield* OrchestratorV2;
    for (const [threadId, rails] of ctx.deferredWakes) {
      const waiting = [...rails].filter(([rail]) => rail === "digest");
      const shell = ctx.shells.get(threadId);
      if (waiting.length === 0 || shell?.activityRunStatus == null) continue;
      const lastActivityMs = Math.max(
        ctx.startedAtMs,
        ...[
          shell.activityRunStartedAt,
          shell.latestUserMessageAt,
          shell.latestVisibleMessage?.updatedAt,
        ].flatMap((at) => (at == null ? [] : [DateTime.toEpochMillis(at)])),
      );
      if (nowMs(ctx) - lastActivityMs < DEFERRED_WAKE_SILENCE_MS) continue;
      if (shell.activeRunId !== null) {
        const { turnItems } = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunIds: [shell.activeRunId],
          turnItemStatuses: ["running"],
        });
        if (turnItems.length > 0) continue;
      }
      const silentSince = DateTime.formatIso(DateTime.makeUnsafe(lastActivityMs));
      const outcome = yield* ctx.dispatch("wake-deferred", {
        type: "thread.attention.raise",
        commandId: CommandId.make(wakeDeferredCommandId(threadId, silentSince)),
        threadId,
        createdAt: createdAt(ctx),
        reason: "needs_guidance",
      });
      if (outcome.status === "accepted")
        yield* Effect.logWarning("loom.dispatcher.wake-deferred", {
          threadId,
          silentSince,
          deferred: Object.fromEntries(waiting),
        });
    }
  }),
};
