import { describe, expect, it } from "vite-plus/test";

import { classifyPiProviderError, nextRetryStep } from "./piTurnRetryPolicy.ts";

// Characterisation pin for the retry ladder maths that previously lived inline
// in PiDriver's `scheduleTurnRetry`. The table below is hand-derived from the
// OLD inline decisions (5 primary steps at [15,30,45,60,90]s on the current
// backend, then 2 fallback-tier steps at [15,60]s with the same-model backend
// switch resolved on the first, then exhaustion). Any divergence here is a
// behaviour change, not a cleanup.
describe("nextRetryStep", () => {
  // A catalogue where the current model has a known partner backend, so the
  // first fallback-tier step resolves a switch target.
  const catalogue = ["anthropic/claude-opus-4-8", "google-vertex-claude/claude-opus-4-8"];
  const current = "anthropic/claude-opus-4-8";
  const partner = "google-vertex-claude/claude-opus-4-8";

  const table: ReadonlyArray<[number, ReturnType<typeof nextRetryStep>]> = [
    [0, { attempt: 1, delayMs: 15_000 }],
    [1, { attempt: 2, delayMs: 30_000 }],
    [2, { attempt: 3, delayMs: 45_000 }],
    [3, { attempt: 4, delayMs: 60_000 }],
    [4, { attempt: 5, delayMs: 90_000 }],
    [5, { attempt: 6, delayMs: 15_000, switchToModel: partner }],
    [6, { attempt: 7, delayMs: 60_000 }],
    [7, undefined], // ladder exhausted
  ];

  for (const [previousAttempt, expected] of table)
    it(`previousAttempt=${previousAttempt} ⇒ ${JSON.stringify(expected)}`, () => {
      expect(nextRetryStep(previousAttempt, current, catalogue)).toEqual(expected);
    });

  it("returns undefined at the fallback-switch step when no partner backend hosts the model", () => {
    // openai-codex has no partner and no other backend hosting gpt-5.5 here.
    expect(nextRetryStep(5, "openai-codex/gpt-5.5", catalogue)).toBeUndefined();
    // Primary-tier steps still schedule even without a fallback partner.
    expect(nextRetryStep(0, "openai-codex/gpt-5.5", catalogue)).toEqual({
      attempt: 1,
      delayMs: 15_000,
    });
  });
});

describe("classifyPiProviderError", () => {
  it("prioritises non-retryable client-request errors over everything else", () => {
    // A message that is both HTTP 400 (non-retryable) and rate-limit-shaped
    // must classify as non_retryable_request (400 is checked first).
    expect(classifyPiProviderError("[HTTP 400] invalid_request_error: rate limit")).toBe(
      "non_retryable_request",
    );
    expect(classifyPiProviderError("should match pattern for tool_use.id")).toBe(
      "non_retryable_request",
    );
  });

  it("classifies quota-shaped errors ahead of the transient ladder", () => {
    // Quota-window wording (checked before transient) — even alongside a 429.
    expect(classifyPiProviderError("429 usage limit reached; resets at 23:00")).toBe(
      "quota_shaped",
    );
    expect(classifyPiProviderError("weekly limit reached")).toBe("quota_shaped");
  });

  it("classifies transient capacity/plumbing errors", () => {
    for (const message of ["529 overloaded_error", "429 Too Many Requests", "socket hang up"])
      expect(classifyPiProviderError(message)).toBe("transient");
  });

  it("classifies unmatched errors as other", () => {
    expect(classifyPiProviderError("context length exceeded")).toBe("other");
    expect(classifyPiProviderError("401 authentication_error: invalid x-api-key")).toBe("other");
  });
});
