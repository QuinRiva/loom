/**
 * AccountUsageRegistry — live, account-scoped subscription-usage snapshots.
 *
 * Holds the latest normalised {@link AccountUsageSnapshot} per provider instance
 * (keyed by `providerInstanceId`, falling back to `providerName`). The data is
 * ephemeral global server state: it is never persisted and simply repopulates
 * from the next provider rate-limit event after a restart. `ProviderRuntimeIngestion`
 * writes to it; the WS config stream reads its snapshot + change stream.
 *
 * Provider rate-limit events are sparse rolling updates (Codex documents this
 * explicitly; Claude reports a single window per event), so updates merge at the
 * window level — an incoming window of a given kind + scope replaces the stored
 * one of that key, while the other windows are preserved.
 *
 * @module AccountUsageRegistry
 */
import type {
  AccountUsageSnapshot,
  AccountUsageWindow,
  AccountUsageWindowKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export interface AccountUsageRegistryShape {
  /** The full current per-instance snapshot list. */
  readonly snapshot: Effect.Effect<ReadonlyArray<AccountUsageSnapshot>>;
  /** Merge one snapshot into the registry and publish the full updated list. */
  readonly update: (snapshot: AccountUsageSnapshot) => Effect.Effect<void>;
  /** Stream of the full current snapshot list — one emission per change. */
  readonly streamChanges: Stream.Stream<ReadonlyArray<AccountUsageSnapshot>>;
  /**
   * Least-squares slope (official Δ% per minute) of the recent sample buffer for
   * one account key + window, used to project gauge depletion
   * (docs/usage-dashboard-design.md §D4.1). Returns null when the guards fail:
   * fewer than 3 distinct samples, a span under 10 min, a non-positive slope,
   * or a stale newest sample (never extrapolate stale official data). The
   * buffer is memory-only, so a restart merely suppresses the projection for
   * ~10 min. `key` matches the registry key `providerInstanceId ?? providerName`.
   */
  readonly usageSlopePerMinute: (
    key: string,
    windowKind: AccountUsageWindowKind,
    nowMs: number,
    scopeDisplayName?: string,
  ) => Effect.Effect<number | null>;
}

export class AccountUsageRegistry extends Context.Service<
  AccountUsageRegistry,
  AccountUsageRegistryShape
>()("t3/provider/Services/AccountUsageRegistry") {}

const usageKey = (snapshot: AccountUsageSnapshot): string =>
  snapshot.providerInstanceId ?? snapshot.providerName;

// Sample ring buffer (§D4.1). Samples accrue at poller cadence (~60 s); we keep
// the last hour and require a 10-min span before projecting.
const SAMPLE_RETENTION_MS = 60 * 60_000;
const SAMPLE_STALE_MS = 5 * 60_000;
const SAMPLE_MIN_COUNT = 3;
const SAMPLE_MIN_SPAN_MS = 10 * 60_000;
// A material % drop means the provider window reset (official % is otherwise
// non-decreasing); mixing pre- and post-reset samples yields a garbage slope
// that suppresses projections for up to the retention hour.
const SAMPLE_RESET_DROP_PERCENT = 5;

interface UsageSample {
  readonly atMs: number;
  readonly percent: number;
}

const windowMergeKey = (window: AccountUsageWindow): string =>
  `${window.kind}\u0000${window.scope?.displayName ?? ""}`;

const sampleBufferKey = (
  key: string,
  kind: AccountUsageWindowKind,
  scopeDisplayName?: string,
): string => `${key}\u0000${kind}\u0000${scopeDisplayName ?? ""}`;

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

/**
 * Append the snapshot's per-window official % to the sample buffers, keyed by
 * account key + window kind + scope. Dedupes on `observedAt` (the poller re-emits the
 * same reading between whole-percent steps) and prunes to the retention window.
 */
const recordSamples = (
  buffers: ReadonlyMap<string, ReadonlyArray<UsageSample>>,
  snapshot: AccountUsageSnapshot,
): ReadonlyMap<string, ReadonlyArray<UsageSample>> => {
  const observedAtMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAtMs)) return buffers;
  const next = new Map(buffers);
  for (const window of snapshot.windows) {
    if (!Number.isFinite(window.usedPercent)) continue;
    const bufKey = sampleBufferKey(usageKey(snapshot), window.kind, window.scope?.displayName);
    const existing = next.get(bufKey) ?? [];
    const last = existing[existing.length - 1];
    if (last !== undefined && last.atMs === observedAtMs) continue;
    const percent = clampPercent(window.usedPercent);
    // Start the buffer fresh across a window reset (see SAMPLE_RESET_DROP_PERCENT).
    const base =
      last !== undefined && last.percent - percent >= SAMPLE_RESET_DROP_PERCENT ? [] : existing;
    const pruned = [...base, { atMs: observedAtMs, percent }].filter(
      (sample) => observedAtMs - sample.atMs <= SAMPLE_RETENTION_MS,
    );
    next.set(bufKey, pruned);
  }
  return next;
};

/**
 * Least-squares slope (%/min) over the buffer, or null when the §D4.1 guards
 * fail. Guards: newest sample fresh (not stale), ≥3 distinct samples spanning
 * ≥10 min, positive slope.
 */
const slopePerMinute = (samples: ReadonlyArray<UsageSample>, nowMs: number): number | null => {
  const newest = samples[samples.length - 1];
  const oldest = samples[0];
  if (samples.length < SAMPLE_MIN_COUNT || newest === undefined || oldest === undefined) {
    return null;
  }
  if (nowMs - newest.atMs > SAMPLE_STALE_MS) return null;
  if (newest.atMs - oldest.atMs < SAMPLE_MIN_SPAN_MS) return null;
  const points = samples.map((sample) => ({
    t: (sample.atMs - oldest.atMs) / 60_000,
    y: sample.percent,
  }));
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / points.length;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    const dt = p.t - meanT;
    numerator += dt * (p.y - meanY);
    denominator += dt * dt;
  }
  if (denominator <= 0) return null;
  const slope = numerator / denominator;
  return slope > 0 ? slope : null;
};

const mergeWindows = (
  existing: ReadonlyArray<AccountUsageWindow>,
  incoming: ReadonlyArray<AccountUsageWindow>,
): ReadonlyArray<AccountUsageWindow> => {
  const byKey = new Map<string, AccountUsageWindow>();
  for (const window of existing) byKey.set(windowMergeKey(window), window);
  for (const window of incoming) byKey.set(windowMergeKey(window), window);
  return Array.from(byKey.values());
};

export const AccountUsageRegistryLive = Layer.effect(
  AccountUsageRegistry,
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<ReadonlyMap<string, AccountUsageSnapshot>>(new Map());
    const samplesRef = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<UsageSample>>>(new Map());
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<AccountUsageSnapshot>>(),
      PubSub.shutdown,
    );

    const update: AccountUsageRegistryShape["update"] = (incoming) =>
      Ref.update(samplesRef, (buffers) => recordSamples(buffers, incoming)).pipe(
        Effect.andThen(
          Ref.modify(stateRef, (state) => {
            const existing = state.get(usageKey(incoming));
            const merged: AccountUsageSnapshot = {
              ...incoming,
              windows: mergeWindows(existing?.windows ?? [], incoming.windows),
              // Sparse updates may omit plan metadata; never clear a known value.
              planType: incoming.planType ?? existing?.planType ?? null,
            };
            const next = new Map(state);
            next.set(usageKey(incoming), merged);
            const list = Array.from(next.values());
            return [list, next] as const;
          }),
        ),
        Effect.flatMap((list) => PubSub.publish(changesPubSub, list).pipe(Effect.asVoid)),
      );

    const usageSlopePerMinute: AccountUsageRegistryShape["usageSlopePerMinute"] = (
      key,
      windowKind,
      nowMs,
      scopeDisplayName,
    ) =>
      Ref.get(samplesRef).pipe(
        Effect.map((buffers) =>
          slopePerMinute(
            buffers.get(sampleBufferKey(key, windowKind, scopeDisplayName)) ?? [],
            nowMs,
          ),
        ),
      );

    return {
      snapshot: Ref.get(stateRef).pipe(Effect.map((state) => Array.from(state.values()))),
      update,
      streamChanges: Stream.fromPubSub(changesPubSub),
      usageSlopePerMinute,
    } satisfies AccountUsageRegistryShape;
  }),
);
