/**
 * ProviderHealthRegistry — ephemeral exhaustion state for subscription accounts.
 *
 * Separate from {@link AccountUsageRegistry} (which stores "what the provider
 * reported") because exhaustion is "what T3 concluded": marks derive from two
 * automatic sources plus a manual pause, expire on a TTL, and are consumed by
 * routing (chunk C), the resume sweep (chunk D), and the UI (chunk F).
 *
 * Marks are keyed `(accountKey, modelScope)` where `accountKey` is the
 * `AccountUsageRegistry` key (`providerInstanceId ?? providerName`) and
 * `modelScope` is `"*"` (account-wide) or a pi modelId. A model is exhausted iff
 * its own model-scoped mark is active OR the account's `"*"` mark is active.
 *
 * Sources (§4.4, strongest first):
 *  1. Explicit provider flags — Codex `limitReached` ⇒ account-wide mark.
 *  2. Telemetry threshold — any window ≥99% ⇒ mark (scoped if the window is
 *     scoped) with `until = resetsAt`. Proactive (D4).
 *  3. Classified limit errors — {@link ProviderHealthRegistryShape.markExhausted}
 *     (source "error"); default 30-min TTL when no resetsAt is known.
 *
 * Clearing is automatic: `until` passed ⇒ inert (checked at query time); fresh
 * telemetry <97% for a key ⇒ its telemetry/error marks drop; restart ⇒ clean
 * slate (no persistence — repopulates from the next poll within ~60s).
 *
 * Soft-pause: accounts in `settings.providerFailover.pausedAccounts` are treated
 * as exhausted account-wide indefinitely (`until = null`, source "manual").
 *
 * @module ProviderHealthRegistry
 */
import type { AccountUsageSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { AccountUsageRegistry } from "./AccountUsageRegistry.ts";

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
  /** ISO resetsAt; null ⇒ unknown/indefinite (paused, or no reset data). */
  readonly until: string | null;
  readonly source: "telemetry" | "error" | "manual";
  /** For UI/reason strings (e.g. "Fable"). */
  readonly displayName?: string;
  /** Human window label for reason strings (e.g. "weekly", "5-hour"); telemetry
   * marks only — error/manual marks don't know which window tripped. */
  readonly windowLabel?: string;
}

/** Human label for a usage-window kind (§5.4 reroute reasons). */
export const windowKindLabel = (kind: "primary" | "secondary"): string =>
  kind === "primary" ? "5-hour" : "weekly";

export interface ProviderHealthRegistryShape {
  /** True iff the model (or its account) has an active exhaustion mark. */
  readonly isExhausted: (
    accountKey: string,
    modelId?: string,
    now?: number,
  ) => Effect.Effect<boolean>;
  /**
   * ISO time the model/account is exhausted until, or null when indefinite
   * (paused / no reset data). Undefined-shaped callers should gate on
   * {@link isExhausted} first; a healthy key also returns null.
   */
  readonly exhaustedUntil: (accountKey: string, modelId?: string) => Effect.Effect<string | null>;
  /** Record an error-sourced mark (default 30-min TTL when `until` is null). */
  readonly markExhausted: (mark: ExhaustionMark) => Effect.Effect<void>;
  /** All currently-active marks (paused + telemetry + error), for the UI feed. */
  readonly snapshot: Effect.Effect<ReadonlyArray<ExhaustionMark>>;
  /** One emission per change. */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ExhaustionMark>>;
}

export class ProviderHealthRegistry extends Context.Service<
  ProviderHealthRegistry,
  ProviderHealthRegistryShape
>()("t3/provider/Services/ProviderHealthRegistry") {}

export const markKey = (accountKey: string, modelScope: string): string =>
  `${accountKey}\u0000${modelScope}`;

export const isActive = (mark: ExhaustionMark, now: number): boolean =>
  mark.until === null || Date.parse(mark.until) > now;

export const matches = (mark: ExhaustionMark, accountKey: string, modelId?: string): boolean =>
  mark.accountKey === accountKey &&
  (mark.modelScope === ACCOUNT_WIDE_SCOPE || mark.modelScope === modelId);

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

  for (const snapshot of snapshots) {
    const accountKey = snapshot.providerInstanceId ?? snapshot.providerName;
    let flagUntil: string | null = null;
    let flagPercent = -1;
    for (const window of snapshot.windows) {
      if (window.usedPercent > flagPercent) {
        flagPercent = window.usedPercent;
        flagUntil = window.resetsAt;
      }
      // Routing scope: an unscoped window is account-wide ("*"); a scoped window
      // routes to its resolved modelId. A scoped window whose display name did
      // NOT map to a modelId is display-only (§4.2) — it must NEVER produce a
      // routing mark (else an unmapped "Fable" at 100% would exhaust the whole
      // account), nor clear the account-wide error mark.
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

/**
 * Drop error-sourced marks for accounts that transitioned paused → unpaused, so
 * the manual escape hatch (§4.4: "pause + unpause forces re-derivation from
 * current telemetry") clears a wrong automatic mark immediately. Telemetry marks
 * are rebuilt every stream tick, so only error marks need explicit dropping.
 */
export const dropUnpausedErrorMarks = (
  errorMarks: ReadonlyMap<string, ExhaustionMark>,
  prevPaused: ReadonlySet<string>,
  nextPaused: ReadonlySet<string>,
): ReadonlyMap<string, ExhaustionMark> => {
  const unpaused = new Set([...prevPaused].filter((account) => !nextPaused.has(account)));
  if (unpaused.size === 0) return errorMarks;
  const kept = new Map(errorMarks);
  for (const [key, mark] of kept) if (unpaused.has(mark.accountKey)) kept.delete(key);
  return kept;
};

export const activeMarks = (
  telemetry: ReadonlyMap<string, ExhaustionMark>,
  error: ReadonlyMap<string, ExhaustionMark>,
  paused: ReadonlySet<string>,
  now: number,
): ReadonlyArray<ExhaustionMark> => {
  const merged = new Map<string, ExhaustionMark>();
  for (const account of paused) {
    merged.set(markKey(account, ACCOUNT_WIDE_SCOPE), {
      accountKey: account,
      modelScope: ACCOUNT_WIDE_SCOPE,
      until: null,
      source: "manual",
    });
  }
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
    const usage = yield* AccountUsageRegistry;
    const settings = yield* ServerSettingsService;

    const telemetryRef = yield* Ref.make<ReadonlyMap<string, ExhaustionMark>>(new Map());
    const errorRef = yield* Ref.make<ReadonlyMap<string, ExhaustionMark>>(new Map());
    const pausedRef = yield* Ref.make<ReadonlySet<string>>(new Set());
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ExhaustionMark>>(),
      PubSub.shutdown,
    );

    const publish = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const [telemetry, error, paused] = yield* Effect.all([
        Ref.get(telemetryRef),
        Ref.get(errorRef),
        Ref.get(pausedRef),
      ]);
      yield* PubSub.publish(changesPubSub, activeMarks(telemetry, error, paused, nowMs));
    }).pipe(Effect.asVoid);

    const isExhausted: ProviderHealthRegistryShape["isExhausted"] = (accountKey, modelId, now) =>
      Effect.gen(function* () {
        const [telemetry, error, paused] = yield* Effect.all([
          Ref.get(telemetryRef),
          Ref.get(errorRef),
          Ref.get(pausedRef),
        ]);
        if (paused.has(accountKey)) return true;
        const at = now ?? (yield* Clock.currentTimeMillis);
        const hit = (mark: ExhaustionMark) =>
          matches(mark, accountKey, modelId) && isActive(mark, at);
        return Array.from(telemetry.values()).some(hit) || Array.from(error.values()).some(hit);
      });

    const exhaustedUntil: ProviderHealthRegistryShape["exhaustedUntil"] = (accountKey, modelId) =>
      Effect.gen(function* () {
        const [telemetry, error, paused] = yield* Effect.all([
          Ref.get(telemetryRef),
          Ref.get(errorRef),
          Ref.get(pausedRef),
        ]);
        if (paused.has(accountKey)) return null;
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

    const markExhausted: ProviderHealthRegistryShape["markExhausted"] = (mark) =>
      Effect.gen(function* () {
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
      const [t, e, p] = yield* Effect.all([
        Ref.get(telemetryRef),
        Ref.get(errorRef),
        Ref.get(pausedRef),
      ]);
      return activeMarks(t, e, p, nowMs);
    });

    // Telemetry subscription: rebuild telemetry marks + clear reset error marks.
    yield* Effect.forkScoped(
      usage.streamChanges.pipe(
        Stream.runForEach((snapshots) =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const error = yield* Ref.get(errorRef);
            const derived = deriveFromTelemetry(snapshots, error, nowMs);
            yield* Ref.set(telemetryRef, derived.telemetry);
            yield* Ref.set(errorRef, derived.error);
            yield* publish;
          }),
        ),
      ),
    );

    // Settings subscription: track paused accounts (initial + on change).
    // Unpausing an account drops its error-sourced marks so the manual escape
    // hatch works as documented (§4.4): "pause + unpause forces re-derivation
    // from current telemetry". Telemetry marks are already live (rebuilt every
    // stream tick), so clearing the error marks is what makes a wrong automatic
    // mark disappear immediately instead of lingering until its TTL.
    const applyPaused = (pausedAccounts: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const next = new Set(pausedAccounts);
        const prev = yield* Ref.get(pausedRef);
        yield* Ref.update(errorRef, (marks) => dropUnpausedErrorMarks(marks, prev, next));
        yield* Ref.set(pausedRef, next);
        yield* publish;
      });
    yield* settings.getSettings.pipe(
      Effect.flatMap((s) => applyPaused(s.providerFailover.pausedAccounts)),
      Effect.ignore,
    );
    yield* Effect.forkScoped(
      settings.streamChanges.pipe(
        Stream.runForEach((s) => applyPaused(s.providerFailover.pausedAccounts)),
      ),
    );

    return {
      isExhausted,
      exhaustedUntil,
      markExhausted,
      snapshot,
      streamChanges: Stream.fromPubSub(changesPubSub),
    } satisfies ProviderHealthRegistryShape;
  }),
);
