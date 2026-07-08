// @effect-diagnostics globalDate:off
// ── T3-level provider-error retry + backend fallback (pure policy) ─────────
// The pure retry/failover DECISIONS extracted from PiDriver's session runner:
// transient-vs-quota-vs-fatal classification, the two delay ladders, the
// backend-partner failover table, and the attempt→step maths. The driver keeps
// the effectful orchestration (timers, process.request, emit, session mutation,
// health-registry corroboration) and consumes these decisions through this
// module. No behavioural change: every constant, regex and decision is verbatim
// from the previous inline form.

import { PI_QUOTA_ERROR_RE } from "../exhaustionMapping.ts";

/** Parse a pi model slug (`provider/modelId`) into its parts, or undefined. */
export function resolvePiModel(model: string): { provider: string; modelId: string } | undefined {
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : undefined;
}

// pi already auto-retries transient provider errors on a fast schedule
// (~2s/4s/8s). Overload episodes often last minutes, so when pi's retries
// exhaust we run a second, slower tier ON TOP: re-dispatch the turn on the
// current backend per T3_RETRY_DELAYS_MS, then switch to the SAME model on
// another backend (Anthropic-direct ↔ Vertex are distinct capacity pools) for
// a brief allowance, then give up into the normal failed-turn path. The
// fallback is per-turn only: the next sendTurn re-issues `set_model` from the
// thread's stored selection.

/** Slow-tier retry schedule on the turn's current backend. */
export const T3_RETRY_DELAYS_MS: ReadonlyArray<number> = [15_000, 30_000, 45_000, 60_000, 90_000];
/** Brief allowance on the fallback backend before giving up. */
export const T3_FALLBACK_RETRY_DELAYS_MS: ReadonlyArray<number> = [15_000, 60_000];
/** Short settle before a reactive tier-2 switch re-prompts on the fallback. */
export const T3_QUOTA_FAILOVER_DELAY_MS = 2_000;

/**
 * Transient (retry-worthy) provider errors — capacity/plumbing, not user
 * fault. Mirrors the spirit of pi's own retryable-error regex: 529 overloaded,
 * 429 rate limits, 5xx, and network-shaped failures. Auth/validation errors
 * deliberately do NOT match and fail immediately.
 */
export const PI_TRANSIENT_PROVIDER_ERROR_RE =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?(error|refused|reset|lost)|socket hang up|fetch failed|terminated|stream ended before|timed?.?out|timeout/i;

/**
 * Non-retryable client-request errors (HTTP 400 `invalid_request_error`) — the
 * request is malformed, so replaying the identical history every attempt fails
 * identically. The canonical case here is Anthropic rejecting a codex-style
 * `tool_use.id` (`String should match pattern`) that reached it un-sanitised.
 * Classified as `validation_error` so it burns neither pi's/the T3 transient
 * ladder nor the exhaustion resume sweep (which only re-runs `quota_exhausted`).
 */
export const PI_NON_RETRYABLE_REQUEST_ERROR_RE =
  /invalid_request_error|\[HTTP 400\]|should match pattern|tool_use\.id/i;

/** Preferred capacity-pool partner per provider namespace (checked first; the
 * generic same-model-other-provider scan is the fallback). Both directions of
 * the Anthropic-direct ↔ Vertex pair are known-good, authenticated pools. */
const PI_BACKEND_PARTNERS: Record<string, string> = {
  anthropic: "google-vertex-claude",
  "google-vertex-claude": "anthropic",
};

/**
 * Derive the same-model-different-backend fallback slug from pi's live
 * catalogue: prefer the known partner pool, else the first other provider
 * hosting the identical modelId. Undefined when no equivalent exists.
 */
export function piBackendFallbackModel(
  currentModel: string | undefined,
  availableModels: Iterable<string>,
): string | undefined {
  const current = currentModel === undefined ? undefined : resolvePiModel(currentModel);
  if (!current) return undefined;
  const slugs = [...availableModels];
  const partner = PI_BACKEND_PARTNERS[current.provider];
  if (partner !== undefined && slugs.includes(`${partner}/${current.modelId}`))
    return `${partner}/${current.modelId}`;
  return slugs.find((slug) => {
    const parsed = resolvePiModel(slug);
    return (
      parsed !== undefined &&
      parsed.modelId === current.modelId &&
      parsed.provider !== current.provider
    );
  });
}

/**
 * Outcome of a finished pi agent run: the last assistant message's
 * `stopReason`/`errorMessage` from the `agent_end` messages array.
 */
export function piRunOutcome(messages: ReadonlyArray<Record<string, unknown>> | undefined): {
  stopReason: string | undefined;
  errorMessage: string | undefined;
} {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const message = messages![i]!;
    if (message.role === "assistant") {
      return {
        stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
        errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
      };
    }
  }
  return { stopReason: undefined, errorMessage: undefined };
}

/** Concise reset-time label for reroute reasons, e.g. "07 Jul 23:00". */
export const formatResetTime = (iso: string | null): string | undefined => {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleString("en-AU", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
};

/** In-band control-plane framing for the retry re-prompt (the errored run left
 * pi idle; a fresh prompt is the only way to resume it). */
export const buildPiRetryPrompt = (errorMessage: string): string =>
  [
    "[T3 Code control plane — automated retry after a provider error; not a message from the user]",
    "",
    `Your previous response failed with a transient provider error (${errorMessage}); none of it was delivered.`,
    "Continue the task from where you left off.",
  ].join("\n");

/** One slow-tier retry decision derived from the attempt ladder. */
export interface RetryStep {
  readonly attempt: number;
  readonly delayMs: number;
  /** Set exactly on the first fallback-tier attempt; undefined otherwise. */
  readonly switchToModel?: string;
}

/**
 * Next slow-tier retry step given the previous attempt count. Primary tier
 * (attempts 1..N) re-dispatches on the current backend at T3_RETRY_DELAYS_MS;
 * the fallback tier switches to the same model on a partner backend on its
 * first step, then allows one more delay before exhaustion.
 *
 * undefined ⇒ ladder exhausted (or no fallback backend exists) ⇒ terminal
 * failure path.
 */
export const nextRetryStep = (
  previousAttempt: number, // session.retry?.attempt ?? 0
  currentModel: string | undefined,
  availableModels: Iterable<string>,
): RetryStep | undefined => {
  const attempt = previousAttempt + 1;
  const primary = T3_RETRY_DELAYS_MS.length;
  if (attempt <= primary) return { attempt, delayMs: T3_RETRY_DELAYS_MS[attempt - 1]! };
  const fallbackIndex = attempt - primary - 1;
  if (fallbackIndex >= T3_FALLBACK_RETRY_DELAYS_MS.length) return undefined;
  const delayMs = T3_FALLBACK_RETRY_DELAYS_MS[fallbackIndex]!;
  if (fallbackIndex === 0) {
    const switchToModel = piBackendFallbackModel(currentModel, availableModels);
    return switchToModel === undefined ? undefined : { attempt, delayMs, switchToModel };
  }
  return { attempt, delayMs };
};

/** Regex-layer classification of a failed pi turn's error message. The
 * effectful, corroborated quota branch (transient + health-registry-exhausted)
 * stays in the driver; this is the pure regex verdict only. */
export type PiErrorClass = "non_retryable_request" | "quota_shaped" | "transient" | "other";

/**
 * Classify by regex in priority order: non-retryable client-request (HTTP 400)
 * → quota-shaped → transient capacity/plumbing → other. The ordering is the
 * contract: a non-retryable request never enters the retry ladder, and a
 * quota-shaped error is never treated as a bare transient.
 */
export const classifyPiProviderError = (errorMessage: string): PiErrorClass =>
  PI_NON_RETRYABLE_REQUEST_ERROR_RE.test(errorMessage)
    ? "non_retryable_request"
    : PI_QUOTA_ERROR_RE.test(errorMessage)
      ? "quota_shaped"
      : PI_TRANSIENT_PROVIDER_ERROR_RE.test(errorMessage)
        ? "transient"
        : "other";
