/**
 * Ephemeral exhaustion marks keyed `(accountKey, modelScope)` (`"*"` = account-wide), from Codex
 * `limitReached`, any window >=99% (until `resetsAt`) or classified errors (30-min TTL). They lapse
 * at `until`, drop on fresh telemetry <97%, and are not persisted: a restart repopulates on poll.
 *
 * @module ProviderHealthRegistry
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  type AccountUsageSnapshot,
  type AccountUsageWindow,
  accountUsageRoutingKey,
  mergeAccountUsage,
} from "./accountUsage.loom.ts";

/** Percent at/above which a usage window is treated as exhausted (proactive). */
const EXHAUSTION_THRESHOLD_PERCENT = 99;
/** Percent below which fresh telemetry clears a mark (window reset / rounding). */
const CLEAR_THRESHOLD_PERCENT = 97;
/** TTL for error-sourced marks with no known resetsAt — bounded blast radius. */
const ERROR_MARK_DEFAULT_TTL_MS = 30 * 60_000;

export const ACCOUNT_WIDE_SCOPE = "*";

export interface ExhaustionMark {
  readonly accountKey: string;
  /** `"*"` (account-wide) or a pi modelId. */
  readonly modelScope: string;
  /** ISO resetsAt; null ⇒ unknown/indefinite (no reset data). */
  readonly until: string | null;
  readonly source: "telemetry" | "error";
  /** For UI/reason strings (e.g. "Fable"). */
  readonly displayName?: string;
  /** Human window label for reason strings (e.g. "weekly", "5-hour"); telemetry
   * marks only — error marks don't know which window tripped. */
  readonly windowLabel?: string;
}

/** Human label for a usage-window kind (§5.4 reroute reasons). */
const windowKindLabel = (kind: "primary" | "secondary"): string =>
  kind === "primary" ? "5-hour" : "weekly";

export interface ProviderHealthRegistryShape {
  /**
   * Fold one account-usage reading in (sparse windows merge by kind+scope) and
   * re-derive the telemetry marks. The poller is the only caller.
   */
  readonly applyUsage: (snapshot: AccountUsageSnapshot) => Effect.Effect<void>;
  /** The current per-account usage readings, for spawn headroom (§4). */
  readonly usage: Effect.Effect<ReadonlyArray<AccountUsageSnapshot>>;
  /** True iff the model (or its account) has an active exhaustion mark. */
  readonly isExhausted: (
    accountKey: string,
    modelId?: string,
    now?: number,
  ) => Effect.Effect<boolean>;
  /**
   * ISO time the model/account is exhausted until, or null when indefinite
   * (no reset data). Undefined-shaped callers should gate on
   * {@link isExhausted} first; a healthy key also returns null.
   */
  readonly exhaustedUntil: (accountKey: string, modelId?: string) => Effect.Effect<string | null>;
  /** Record an error-sourced mark (default 30-min TTL when `until` is null). */
  readonly markExhausted: (mark: ExhaustionMark) => Effect.Effect<void>;
  /** All currently-active marks (telemetry + error), for the UI feed. */
  readonly snapshot: Effect.Effect<ReadonlyArray<ExhaustionMark>>;
  /** One emission per change. */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ExhaustionMark>>;
}

export class ProviderHealthRegistry extends Context.Service<
  ProviderHealthRegistry,
  ProviderHealthRegistryShape
>()("t3/provider/ProviderHealthRegistry") {}

export const markKey = (accountKey: string, modelScope: string): string =>
  `${accountKey}\u0000${modelScope}`;

export const isActive = (mark: ExhaustionMark, now: number): boolean =>
  mark.until === null || Date.parse(mark.until) > now;

export const matches = (mark: ExhaustionMark, accountKey: string, modelId?: string): boolean =>
  mark.accountKey === accountKey &&
  (mark.modelScope === ACCOUNT_WIDE_SCOPE || mark.modelScope === modelId);

/**
 * Collapse an instance's pooled accounts into one view: the router fails over between them, so
 * the instance is exhausted only when every account is. Per window label, keep the windows of the
 * one account whose worst window is lowest (ties: earliest reset); a per-window minimum across
 * accounts reads two half-spent accounts as healthy. `limitReached` counts only when all set it.
 */
export const aggregateAccountsBestRemaining = (
  snapshots: ReadonlyArray<AccountUsageSnapshot>,
): ReadonlyArray<AccountUsageSnapshot> => {
  const groups = new Map<string, AccountUsageSnapshot[]>();
  for (const snapshot of snapshots) {
    const group = groups.get(accountUsageRoutingKey(snapshot));
    if (group) group.push(snapshot);
    else groups.set(accountUsageRoutingKey(snapshot), [snapshot]);
  }
  const label = (window: AccountUsageWindow): string => window.scope?.displayName ?? "";
  const resetMs = (window: AccountUsageWindow): number =>
    window.resetsAt === null ? Infinity : Date.parse(window.resetsAt);
  return Array.from(groups.values(), (group) => {
    if (group.length === 1) return group[0] as AccountUsageSnapshot;
    const freshest = group.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
    const windows = [...new Set(group.flatMap((s) => s.windows.map(label)))].flatMap(
      (name) =>
        group
          .map((s) => s.windows.filter((window) => label(window) === name))
          .filter((accountWindows) => accountWindows.length > 0)
          .map((accountWindows) => ({
            accountWindows,
            worst: accountWindows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)),
          }))
          .reduce((a, b) =>
            b.worst.usedPercent < a.worst.usedPercent ||
            (b.worst.usedPercent === a.worst.usedPercent && resetMs(b.worst) < resetMs(a.worst))
              ? b
              : a,
          ).accountWindows,
    );
    return {
      providerName: freshest.providerName,
      providerInstanceId: freshest.providerInstanceId,
      windows,
      observedAt: freshest.observedAt,
      ...(group.every((s) => s.limitReached === true) ? { limitReached: true } : {}),
    } satisfies AccountUsageSnapshot;
  });
};

/** Rebuild the telemetry mark map + drop reset/expired error marks from a snapshot list. */
export const deriveFromTelemetry = (
  snapshots: ReadonlyArray<AccountUsageSnapshot>,
  errorMarks: ReadonlyMap<string, ExhaustionMark>,
  now: number,
): {
  readonly telemetry: ReadonlyMap<string, ExhaustionMark>;
  readonly error: ReadonlyMap<string, ExhaustionMark>;
} => {
  const telemetry = new Map<string, ExhaustionMark>();
  const error = new Map(errorMarks);
  // Prune error marks whose TTL has passed regardless of telemetry.
  for (const [key, mark] of error) if (!isActive(mark, now)) error.delete(key);

  for (const snapshot of aggregateAccountsBestRemaining(snapshots)) {
    const accountKey = accountUsageRoutingKey(snapshot);
    let flagUntil: string | null = null;
    let flagPercent = -1;
    for (const window of snapshot.windows) {
      if (window.usedPercent > flagPercent) {
        flagPercent = window.usedPercent;
        flagUntil = window.resetsAt;
      }
      // Unscoped is account-wide ("*"); a scoped window whose name mapped to no modelId is
      // display-only: it must never mark (an unmapped "Fable" at 100% would exhaust the account)
      // nor clear the account-wide error mark.
      const routingScope =
        window.scope === undefined ? ACCOUNT_WIDE_SCOPE : (window.scope.modelId ?? null);
      if (routingScope === null) continue;
      if (window.usedPercent >= EXHAUSTION_THRESHOLD_PERCENT) {
        telemetry.set(markKey(accountKey, routingScope), {
          accountKey,
          modelScope: routingScope,
          until: window.resetsAt,
          source: "telemetry",
          windowLabel: windowKindLabel(window.kind),
          ...(window.scope?.displayName ? { displayName: window.scope.displayName } : {}),
        });
      } else if (window.usedPercent < CLEAR_THRESHOLD_PERCENT) {
        // Window reset (or the percent was wrong): drop error marks for this key.
        error.delete(markKey(accountKey, routingScope));
      }
    }
    if (snapshot.limitReached === true) {
      telemetry.set(markKey(accountKey, ACCOUNT_WIDE_SCOPE), {
        accountKey,
        modelScope: ACCOUNT_WIDE_SCOPE,
        until: flagUntil,
        source: "telemetry",
      });
    }
  }
  return { telemetry, error };
};

export const activeMarks = (
  telemetry: ReadonlyMap<string, ExhaustionMark>,
  error: ReadonlyMap<string, ExhaustionMark>,
  now: number,
): ReadonlyArray<ExhaustionMark> => {
  const merged = new Map<string, ExhaustionMark>();
  // Telemetry then error: an error mark refines a key only if telemetry has none.
  for (const mark of telemetry.values())
    if (isActive(mark, now)) merged.set(markKey(mark.accountKey, mark.modelScope), mark);
  for (const mark of error.values())
    if (isActive(mark, now) && !merged.has(markKey(mark.accountKey, mark.modelScope)))
      merged.set(markKey(mark.accountKey, mark.modelScope), mark);
  return Array.from(merged.values());
};

export const ProviderHealthRegistryLive = Layer.effect(
  ProviderHealthRegistry,
  Effect.gen(function* () {
    const usageRef = yield* Ref.make<ReadonlyMap<string, AccountUsageSnapshot>>(new Map());
    const telemetryRef = yield* Ref.make<ReadonlyMap<string, ExhaustionMark>>(new Map());
    const errorRef = yield* Ref.make<ReadonlyMap<string, ExhaustionMark>>(new Map());
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ExhaustionMark>>(),
      PubSub.shutdown,
    );

    const publish = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const [telemetry, error] = yield* Effect.all([Ref.get(telemetryRef), Ref.get(errorRef)]);
      yield* PubSub.publish(changesPubSub, activeMarks(telemetry, error, nowMs));
    }).pipe(Effect.asVoid);

    const isExhausted: ProviderHealthRegistryShape["isExhausted"] = Effect.fn(
      "ProviderHealthRegistry.isExhausted",
    )(function* (accountKey, modelId, now) {
      const [telemetry, error] = yield* Effect.all([Ref.get(telemetryRef), Ref.get(errorRef)]);
      const at = now ?? (yield* Clock.currentTimeMillis);
      const hit = (mark: ExhaustionMark) =>
        matches(mark, accountKey, modelId) && isActive(mark, at);
      return Array.from(telemetry.values()).some(hit) || Array.from(error.values()).some(hit);
    });

    const exhaustedUntil: ProviderHealthRegistryShape["exhaustedUntil"] = Effect.fn(
      "ProviderHealthRegistry.exhaustedUntil",
    )(function* (accountKey, modelId) {
      const [telemetry, error] = yield* Effect.all([Ref.get(telemetryRef), Ref.get(errorRef)]);
      const now = yield* Clock.currentTimeMillis;
      const relevant = [...telemetry.values(), ...error.values()].filter(
        (mark) => matches(mark, accountKey, modelId) && isActive(mark, now),
      );
      if (relevant.length === 0) return null;
      // Available again only once every active mark clears; a null (unknown)
      // until dominates.
      if (relevant.some((mark) => mark.until === null)) return null;
      return relevant.reduce(
        (latest, mark) =>
          latest === null || Date.parse(mark.until!) > Date.parse(latest) ? mark.until : latest,
        null as string | null,
      );
    });

    const markExhausted: ProviderHealthRegistryShape["markExhausted"] = Effect.fn(
      "ProviderHealthRegistry.markExhausted",
    )(function* (mark) {
      const nowMs = yield* Clock.currentTimeMillis;
      const resolved: ExhaustionMark =
        mark.source === "error" && mark.until === null
          ? {
              ...mark,
              until: DateTime.formatIso(DateTime.makeUnsafe(nowMs + ERROR_MARK_DEFAULT_TTL_MS)),
            }
          : mark;
      yield* Ref.update(errorRef, (marks) => {
        const next = new Map(marks);
        next.set(markKey(resolved.accountKey, resolved.modelScope), resolved);
        return next;
      });
      yield* publish;
    });

    const snapshot = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const [t, e] = yield* Effect.all([Ref.get(telemetryRef), Ref.get(errorRef)]);
      return activeMarks(t, e, nowMs);
    });

    // Fresh telemetry rebuilds the telemetry marks and clears reset error marks.
    const applyUsage: ProviderHealthRegistryShape["applyUsage"] = Effect.fn(
      "ProviderHealthRegistry.applyUsage",
    )(function* (snapshot) {
      const snapshots = Array.from(
        (yield* Ref.updateAndGet(usageRef, (store) => mergeAccountUsage(store, snapshot))).values(),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      const derived = deriveFromTelemetry(snapshots, yield* Ref.get(errorRef), nowMs);
      yield* Ref.set(telemetryRef, derived.telemetry);
      yield* Ref.set(errorRef, derived.error);
      yield* publish;
    });

    return {
      applyUsage,
      usage: Ref.get(usageRef).pipe(Effect.map((store) => Array.from(store.values()))),
      isExhausted,
      exhaustedUntil,
      markExhausted,
      snapshot,
      streamChanges: Stream.fromPubSub(changesPubSub),
    } satisfies ProviderHealthRegistryShape;
  }),
);
