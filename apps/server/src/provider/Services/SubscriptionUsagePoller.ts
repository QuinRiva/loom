import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SubscriptionUsagePollerShape {
  /**
   * Start the background subscription-usage poller within the provided scope.
   * It reads provider OAuth tokens from disk, fetches account-level rolling-window
   * usage on a timer, and feeds the shared {@link AccountUsageRegistry} — driver-
   * independent, so the sidebar usage pill lights for pi-driven sessions that
   * never emit per-turn rate-limit windows.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class SubscriptionUsagePoller extends Context.Service<
  SubscriptionUsagePoller,
  SubscriptionUsagePollerShape
>()("t3/provider/Services/SubscriptionUsagePoller") {}
