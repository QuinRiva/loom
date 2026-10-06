/**
 * Pi error texts that `classifyPiFailure` reads as usage limits, shared with
 * 3c-2's reroute tests and Phase 4's QA replays.
 *
 * Provenance: "recorded" texts are verbatim from V1's tests or from pi session
 * transcripts of the CLI Proxy (`~/cli-proxy` usage baseline, Aug–Sep 2026);
 * "composed" texts are pi-ai 1.0.3's own templates (`provider-retry.js`
 * `Server requested Ns retry delay`, `openai-codex-responses.js` "Try again in
 * ~N min") wrapped around a recorded body or the documented field values.
 *
 * @module provider/Drivers/Pi/piQuotaClassifier.fixtures
 */

export interface PiQuotaErrorText {
  readonly label: string;
  readonly text: string;
  /** The provider's wait the text names, when it names one. */
  readonly retryAfterMs?: number;
}

const COOLING_DOWN_OPUS =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-5 are cooling down"}}';
const ACCOUNT_RATE_LIMIT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';

/** Usage limits on wording alone, with no health mark. */
export const PI_QUOTA_ERROR_TEXTS: ReadonlyArray<PiQuotaErrorText> = [
  { label: "V1 quota wording beside a 429", text: "429 usage limit reached; resets at 23:00" },
  { label: "V1 weekly window", text: "weekly limit reached" },
  { label: "proxy pool cooling down (recorded)", text: COOLING_DOWN_OPUS },
  {
    label: "proxy pool cooling down with last error (recorded)",
    text: '429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-fable-5-1 are cooling down (last error: claude Fast upstream request failed with status 429)"}}',
  },
  {
    label: "proxy pool cooling down past pi's Retry-After cap (composed)",
    text: `Server requested 3639s retry delay (max: 60s). ${COOLING_DOWN_OPUS}`,
    retryAfterMs: 3_639_000,
  },
  {
    label: "account 5-hour rejection past pi's Retry-After cap (composed; Retry-After recorded)",
    text: `Server requested 3639s retry delay (max: 60s). ${ACCOUNT_RATE_LIMIT}`,
    retryAfterMs: 3_639_000,
  },
  {
    label: "ChatGPT subscription limit (composed)",
    text: "You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min.",
    retryAfterMs: 158 * 60_000,
  },
  {
    label: "OpenAI insufficient_quota",
    text: '429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
  },
];

/** A throttle that is a usage limit only when the account already carries an active mark. */
export const PI_ACCOUNT_RATE_LIMIT_TEXT = ACCOUNT_RATE_LIMIT;

/** Never usage limits, mark or not. */
export const PI_NON_QUOTA_ERROR_TEXTS: ReadonlyArray<string> = [
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.1.tool_use.id: String should match pattern \'^[a-zA-Z0-9_-]+$\'"}}',
  "[HTTP 400] invalid_request_error: rate limit",
  "529 overloaded_error",
  "context length exceeded",
  "401 authentication_error: invalid x-api-key",
];
