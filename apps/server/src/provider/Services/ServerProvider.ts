import type { ProviderUsageLimitsUpdate, ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  /**
   * Ownership-derived update capabilities. Cached between reads; pass
   * `{ fresh: true }` before executing an update so it never trusts a
   * resolution older than the click.
   */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Fold a runtime rate-limit update into the published snapshot without
   * waiting for the next status probe. Sparse: windows merge by id and an
   * update with no usable window leaves the snapshot untouched.
   */
  readonly applyUsageLimits: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
  /**
   * loom: drop the published windows of accounts a feeder has stood down,
   * matched by `usageWindowAccountPrefix`. `applyUsageLimits` only upserts, so
   * without this a retired reading (the poller's Anthropic arms once a cliproxy
   * hub owns Claude quota) stays frozen on the card until restart.
   */
  readonly retractUsageLimits: (input: {
    readonly accountPrefixes: ReadonlyArray<string>;
    readonly checkedAt: string;
  }) => Effect.Effect<void>;
}
