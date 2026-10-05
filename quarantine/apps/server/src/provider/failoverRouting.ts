/**
 * Shared inputs for {@link resolveFailoverTarget} outside the pi driver.
 *
 * The pure chain resolver takes an abstract live-slug `catalogue` and a
 * synchronous `isExhausted` predicate. Inside PiDriver those come from the
 * driver's private model map + registry snapshot; the resume sweep (D) and the
 * spawn-warning path (E) reach the same facts through the `ProviderRegistry`
 * snapshot and the `ProviderHealthRegistry` snapshot instead. These two tiny
 * pure builders keep that derivation identical across both callers.
 *
 * @module failoverRouting
 */
import type { ServerProvider } from "@t3tools/contracts";

import { type ExhaustionMark, matches } from "./Services/ProviderHealthRegistry.ts";

/**
 * Live pi model slugs routable as failover targets, from `ProviderRegistry`
 * snapshots. Empty when pi has not enriched its catalogue yet — callers must
 * degrade like the resolver (a missing target is simply skipped), never treat
 * an empty set as a hard failure.
 */
export const piCatalogueFromProviders = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlySet<string> =>
  new Set(
    providers.flatMap((provider) =>
      provider.driver === "pi" ? provider.models.map((model) => model.slug) : [],
    ),
  );

/**
 * Synchronous exhaustion predicate over an active-mark snapshot (paused
 * accounts already folded in by `ProviderHealthRegistry.activeMarks`). Shape
 * required by {@link resolveFailoverTarget}: a bare account query (no modelId)
 * matches the account-wide `"*"` mark.
 */
export const exhaustionPredicate =
  (marks: ReadonlyArray<ExhaustionMark>) =>
  (accountKey: string, modelId?: string): boolean =>
    marks.some((mark) => matches(mark, accountKey, modelId));
