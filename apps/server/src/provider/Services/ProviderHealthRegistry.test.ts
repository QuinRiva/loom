import { describe, expect, it } from "@effect/vitest";
import { type AccountUsageSnapshot, ProviderInstanceId } from "@t3tools/contracts";

import { classifiesAsQuota } from "../exhaustionMapping.ts";
import {
  ACCOUNT_WIDE_SCOPE,
  activeMarks,
  deriveFromTelemetry,
  dropUnpausedErrorMarks,
  isActive,
  markKey,
  matches,
  type ExhaustionMark,
} from "./ProviderHealthRegistry.ts";

const NOW = Date.parse("2026-07-06T12:00:00.000Z");
const FUTURE = "2026-07-06T18:00:00.000Z";
const PAST = "2026-07-06T06:00:00.000Z";

const snapshot = (
  windows: AccountUsageSnapshot["windows"],
  extra: Partial<AccountUsageSnapshot> = {},
): AccountUsageSnapshot => ({
  providerName: "claudeAgent",
  providerInstanceId: null,
  windows,
  planType: null,
  observedAt: "2026-07-06T12:00:00.000Z",
  ...extra,
});

const errorMark = (
  accountKey: string,
  modelScope: string,
  until: string | null,
): ExhaustionMark => ({
  accountKey,
  modelScope,
  until,
  source: "error",
});

describe("ProviderHealthRegistry semantics", () => {
  it("marks an account-wide window ≥99% but not one below the clear threshold", () => {
    const { telemetry } = deriveFromTelemetry(
      [snapshot([{ kind: "primary", usedPercent: 99, resetsAt: FUTURE, windowDurationMins: 300 }])],
      new Map(),
      NOW,
    );
    const mark = telemetry.get(markKey("claudeAgent", ACCOUNT_WIDE_SCOPE));
    expect(mark?.until).toBe(FUTURE);
    expect(mark?.source).toBe("telemetry");

    const { telemetry: healthy } = deriveFromTelemetry(
      [snapshot([{ kind: "primary", usedPercent: 40, resetsAt: FUTURE, windowDurationMins: 300 }])],
      new Map(),
      NOW,
    );
    expect(healthy.size).toBe(0);
  });

  it("aggregates pooled accounts of one instance to best-remaining (§4)", () => {
    const pool = ProviderInstanceId.make("cliproxy");
    const pooled = (label: string, weeklyPercent: number) =>
      snapshot(
        [
          {
            kind: "secondary",
            usedPercent: weeklyPercent,
            resetsAt: FUTURE,
            windowDurationMins: 10080,
          },
        ],
        { providerName: "cliproxy", providerInstanceId: pool, accountLabel: label },
      );
    // One account spent (99%), one fresh (0%): MIN ⇒ instance not exhausted.
    const { telemetry: healthy } = deriveFromTelemetry(
      [pooled("carl@", 99), pooled("caaarl@", 0)],
      new Map(),
      NOW,
    );
    expect(healthy.size).toBe(0);
    // Both spent ⇒ instance exhausted, keyed by the instance (routing) key.
    const { telemetry: dead } = deriveFromTelemetry(
      [pooled("carl@", 99), pooled("caaarl@", 100)],
      new Map(),
      NOW,
    );
    expect(dead.get(markKey("cliproxy", ACCOUNT_WIDE_SCOPE))?.source).toBe("telemetry");
  });

  it("marks a single-account instance whose only window is ≥99% (limitReached AND)", () => {
    const pool = ProviderInstanceId.make("cliproxy");
    // limitReached on only one pooled account must NOT exhaust the instance.
    const { telemetry } = deriveFromTelemetry(
      [
        snapshot(
          [{ kind: "primary", usedPercent: 10, resetsAt: FUTURE, windowDurationMins: 300 }],
          {
            providerInstanceId: pool,
            accountLabel: "a",
            limitReached: true,
          },
        ),
        snapshot(
          [{ kind: "primary", usedPercent: 10, resetsAt: FUTURE, windowDurationMins: 300 }],
          {
            providerInstanceId: pool,
            accountLabel: "b",
          },
        ),
      ],
      new Map(),
      NOW,
    );
    expect(telemetry.size).toBe(0);
  });

  it("scopes a model-scoped weekly window without exhausting the account", () => {
    const { telemetry } = deriveFromTelemetry(
      [
        snapshot([
          { kind: "secondary", usedPercent: 81, resetsAt: FUTURE, windowDurationMins: 10080 },
          {
            kind: "secondary",
            usedPercent: 100,
            resetsAt: FUTURE,
            windowDurationMins: 10080,
            scope: { displayName: "Fable", modelId: "claude-fable-5" },
          },
        ]),
      ],
      new Map(),
      NOW,
    );
    // Model-scoped mark present; account-wide (all-models 81%) absent.
    expect(telemetry.has(markKey("claudeAgent", "claude-fable-5"))).toBe(true);
    expect(telemetry.has(markKey("claudeAgent", ACCOUNT_WIDE_SCOPE))).toBe(false);
    const marks = activeMarks(telemetry, new Map(), new Set(), NOW);
    expect(marks.some((m) => matches(m, "claudeAgent", "claude-fable-5"))).toBe(true);
    expect(marks.some((m) => matches(m, "claudeAgent", "claude-opus-4-8"))).toBe(false);
  });

  it("never routes an unmapped scoped window and never clears the account-wide mark", () => {
    // Scoped window (displayName present) but modelId unresolved: display-only per
    // §4.2 — must produce NO routing mark even at 100%.
    const { telemetry } = deriveFromTelemetry(
      [
        snapshot([
          {
            kind: "secondary",
            usedPercent: 100,
            resetsAt: FUTURE,
            windowDurationMins: 10080,
            scope: { displayName: "MysteryModel", modelId: null },
          },
        ]),
      ],
      new Map(),
      NOW,
    );
    expect(telemetry.size).toBe(0);

    // An unmapped scoped window below the clear threshold must NOT drop the
    // account-wide error mark (they are unrelated keys).
    const errors = new Map([
      [markKey("claudeAgent", ACCOUNT_WIDE_SCOPE), errorMark("claudeAgent", "*", FUTURE)],
    ]);
    const { error } = deriveFromTelemetry(
      [
        snapshot([
          {
            kind: "secondary",
            usedPercent: 10,
            resetsAt: FUTURE,
            windowDurationMins: 10080,
            scope: { displayName: "MysteryModel", modelId: null },
          },
        ]),
      ],
      errors,
      NOW,
    );
    expect(error.has(markKey("claudeAgent", ACCOUNT_WIDE_SCOPE))).toBe(true);
  });

  it("marks account-wide on an explicit limitReached flag even below 99%", () => {
    const { telemetry } = deriveFromTelemetry(
      [
        snapshot(
          [{ kind: "primary", usedPercent: 96, resetsAt: FUTURE, windowDurationMins: 300 }],
          {
            providerName: "codex",
            limitReached: true,
          },
        ),
      ],
      new Map(),
      NOW,
    );
    expect(telemetry.get(markKey("codex", ACCOUNT_WIDE_SCOPE))?.until).toBe(FUTURE);
  });

  it("clears an error mark when fresh telemetry drops below the clear threshold", () => {
    const errors = new Map([
      [markKey("codex", ACCOUNT_WIDE_SCOPE), errorMark("codex", "*", FUTURE)],
    ]);
    const { error } = deriveFromTelemetry(
      [
        snapshot(
          [{ kind: "primary", usedPercent: 12, resetsAt: FUTURE, windowDurationMins: 300 }],
          {
            providerName: "codex",
          },
        ),
      ],
      errors,
      NOW,
    );
    expect(error.has(markKey("codex", ACCOUNT_WIDE_SCOPE))).toBe(false);
  });

  it("prunes error marks whose TTL has passed", () => {
    const errors = new Map([[markKey("codex", ACCOUNT_WIDE_SCOPE), errorMark("codex", "*", PAST)]]);
    const { error } = deriveFromTelemetry([], errors, NOW);
    expect(error.size).toBe(0);
  });

  it("treats a passed `until` as inert and a null `until` as indefinite", () => {
    expect(isActive(errorMark("codex", "*", PAST), NOW)).toBe(false);
    expect(isActive(errorMark("codex", "*", FUTURE), NOW)).toBe(true);
    expect(isActive(errorMark("codex", "*", null), NOW)).toBe(true);
  });

  it("surfaces paused accounts as account-wide manual marks", () => {
    const marks = activeMarks(new Map(), new Map(), new Set(["claudeAgent"]), NOW);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      accountKey: "claudeAgent",
      modelScope: ACCOUNT_WIDE_SCOPE,
      until: null,
      source: "manual",
    });
    expect(matches(marks[0]!, "claudeAgent", "claude-opus-4-8")).toBe(true);
  });

  it("drops error marks for accounts that transition paused → unpaused", () => {
    const errors = new Map([
      [markKey("codex", ACCOUNT_WIDE_SCOPE), errorMark("codex", "*", FUTURE)],
      [markKey("claudeAgent", ACCOUNT_WIDE_SCOPE), errorMark("claudeAgent", "*", FUTURE)],
    ]);
    // codex unpaused (was paused, now not); claudeAgent unchanged.
    const kept = dropUnpausedErrorMarks(errors, new Set(["codex"]), new Set());
    expect(kept.has(markKey("codex", ACCOUNT_WIDE_SCOPE))).toBe(false);
    expect(kept.has(markKey("claudeAgent", ACCOUNT_WIDE_SCOPE))).toBe(true);
    // No transition ⇒ untouched (same reference is fine).
    expect(dropUnpausedErrorMarks(errors, new Set(["codex"]), new Set(["codex"])).size).toBe(2);
  });

  it("quota-classifies subscription-limit wording but not bare rate-limit/429", () => {
    expect(classifiesAsQuota("You have reached your weekly usage limit")).toBe(true);
    expect(classifiesAsQuota("quota exceeded; resets at 15:40")).toBe(true);
    expect(classifiesAsQuota("5-hour limit reached")).toBe(true);
    // Bare capacity/transient wording must NOT be quota (stays on transient
    // ladder unless an active mark corroborates).
    expect(classifiesAsQuota("429 Too Many Requests")).toBe(false);
    expect(classifiesAsQuota("rate limit exceeded, please retry")).toBe(false);
    expect(classifiesAsQuota("overloaded_error: server is overloaded")).toBe(false);
  });

  it("prefers a telemetry mark over an error mark on the same key", () => {
    const telemetry = new Map([
      [
        markKey("codex", ACCOUNT_WIDE_SCOPE),
        { accountKey: "codex", modelScope: "*", until: FUTURE, source: "telemetry" as const },
      ],
    ]);
    const errors = new Map([
      [markKey("codex", ACCOUNT_WIDE_SCOPE), errorMark("codex", "*", FUTURE)],
    ]);
    const marks = activeMarks(telemetry, errors, new Set(), NOW);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.source).toBe("telemetry");
  });
});
