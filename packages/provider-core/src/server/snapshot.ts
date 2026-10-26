import type { ProviderUsageLimitsUpdate, ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "./maintenance.ts";

export interface ManagedServerProvider {
  /** Cached; pass { fresh: true } before executing updates. */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /** Merge windows by ID; updates with no usable window leave the snapshot untouched. */
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
