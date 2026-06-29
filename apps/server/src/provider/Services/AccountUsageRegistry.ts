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
 * window level — an incoming window of a given kind replaces the stored one of
 * that kind, while the other kind is preserved.
 *
 * @module AccountUsageRegistry
 */
import type { AccountUsageSnapshot, AccountUsageWindow } from "@t3tools/contracts";
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
}

export class AccountUsageRegistry extends Context.Service<
  AccountUsageRegistry,
  AccountUsageRegistryShape
>()("t3/provider/Services/AccountUsageRegistry") {}

const usageKey = (snapshot: AccountUsageSnapshot): string =>
  snapshot.providerInstanceId ?? snapshot.providerName;

const mergeWindows = (
  existing: ReadonlyArray<AccountUsageWindow>,
  incoming: ReadonlyArray<AccountUsageWindow>,
): ReadonlyArray<AccountUsageWindow> => {
  const byKind = new Map<AccountUsageWindow["kind"], AccountUsageWindow>();
  for (const window of existing) byKind.set(window.kind, window);
  for (const window of incoming) byKind.set(window.kind, window);
  return Array.from(byKind.values());
};

export const AccountUsageRegistryLive = Layer.effect(
  AccountUsageRegistry,
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<ReadonlyMap<string, AccountUsageSnapshot>>(new Map());
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<AccountUsageSnapshot>>(),
      PubSub.shutdown,
    );

    const update: AccountUsageRegistryShape["update"] = (incoming) =>
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
      }).pipe(Effect.flatMap((list) => PubSub.publish(changesPubSub, list).pipe(Effect.asVoid)));

    return {
      snapshot: Ref.get(stateRef).pipe(Effect.map((state) => Array.from(state.values()))),
      update,
      streamChanges: Stream.fromPubSub(changesPubSub),
    } satisfies AccountUsageRegistryShape;
  }),
);
