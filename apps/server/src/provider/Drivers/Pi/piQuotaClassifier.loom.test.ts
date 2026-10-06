import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ExhaustionMark } from "../../Services/ProviderHealthRegistry.ts";
import { classifyPiFailure } from "./piQuotaClassifier.loom.ts";
import {
  PI_ACCOUNT_RATE_LIMIT_TEXT,
  PI_NON_QUOTA_ERROR_TEXTS,
  PI_QUOTA_ERROR_TEXTS,
} from "./piQuotaClassifier.fixtures.loom.ts";

const NOW = Date.parse("2026-10-06T00:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const ANTHROPIC = { instanceId: "pi", model: "anthropic/claude-opus-5" };
const POOLED = { instanceId: "pi", model: "cliproxy/claude-opus-5-5" };
const mark = (overrides: Partial<ExhaustionMark>): ExhaustionMark => ({
  accountKey: "claudeAgent",
  modelScope: "*",
  until: iso(NOW + 2 * 3_600_000),
  source: "telemetry",
  windowLabel: "5-hour",
  ...overrides,
});

describe("classifyPiFailure", () => {
  it.each(PI_QUOTA_ERROR_TEXTS)("$label is a usage limit", ({ text, retryAfterMs }) => {
    const result = classifyPiFailure(text, ANTHROPIC, [], NOW);
    expect(result.usageLimit).toBe(true);
    expect(result.retryAfterMs).toBe(retryAfterMs);
    // A reset only when the text names a wait; nothing is invented without one.
    expect(result.resetAt).toBe(retryAfterMs === undefined ? undefined : iso(NOW + retryAfterMs));
  });

  it("reads the proxy's Retry-After as the reset (DL-77 defect 1)", () => {
    expect(classifyPiFailure(PI_QUOTA_ERROR_TEXTS[4]!.text, POOLED, [], NOW)).toEqual({
      usageLimit: true,
      retryAfterMs: 3_639_000,
      resetAt: "2026-10-06T01:00:39.000Z",
    });
  });

  it.each(PI_NON_QUOTA_ERROR_TEXTS)("%s is not a usage limit, even with a mark", (text) => {
    expect(classifyPiFailure(text, ANTHROPIC, [mark({})], NOW)).toEqual({ usageLimit: false });
  });

  it("takes the account window from the health snapshot when the text names no reset", () => {
    expect(classifyPiFailure("weekly limit reached", ANTHROPIC, [mark({})], NOW)).toEqual({
      usageLimit: true,
      resetAt: iso(NOW + 2 * 3_600_000),
      windowLabel: "5-hour",
    });
    // The account is back only when its last window clears.
    const weekly = mark({
      modelScope: "claude-opus-5",
      until: iso(NOW + 86_400_000),
      windowLabel: "weekly",
    });
    expect(classifyPiFailure("usage limit", ANTHROPIC, [mark({}), weekly], NOW)).toMatchObject({
      resetAt: iso(NOW + 86_400_000),
      windowLabel: "weekly",
    });
  });

  it("reads a pooled instance's marks under the instance id", () => {
    expect(
      classifyPiFailure("weekly limit reached", POOLED, [mark({ accountKey: "pi" })], NOW).resetAt,
    ).toBe(iso(NOW + 2 * 3_600_000));
  });

  it("ignores marks of another account, expired marks and guessed (error) windows", () => {
    const ignored = [
      mark({ accountKey: "codex" }),
      mark({ until: iso(NOW - 1) }),
      mark({ source: "error", until: iso(NOW + 30 * 60_000) }),
    ];
    expect(classifyPiFailure("usage limit", ANTHROPIC, ignored, NOW)).toEqual({ usageLimit: true });
    expect(classifyPiFailure("usage limit", ANTHROPIC, [mark({ until: null })], NOW)).toEqual({
      usageLimit: true,
    });
  });

  it("counts a plain 429 only when an active mark corroborates it", () => {
    expect(classifyPiFailure(PI_ACCOUNT_RATE_LIMIT_TEXT, ANTHROPIC, [], NOW)).toEqual({
      usageLimit: false,
    });
    expect(classifyPiFailure(PI_ACCOUNT_RATE_LIMIT_TEXT, ANTHROPIC, [mark({})], NOW)).toEqual({
      usageLimit: true,
      resetAt: iso(NOW + 2 * 3_600_000),
      windowLabel: "5-hour",
    });
  });
});
