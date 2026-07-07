export const PI_SUBSCRIPTION_ACCOUNT_NAMESPACES: Record<string, ReadonlyArray<string>> = {
  claudeAgent: ["anthropic"],
  anthropic: ["anthropic"],
  codex: ["openai-codex"],
  "openai-codex": ["openai-codex"],
};

// pi driver slug namespace → subscription account key (AccountUsageRegistry key
// space: providerInstanceId ?? providerName). `google-vertex-claude` is
// API-billed — no subscription window, so it never maps to an account key and
// never registers exhaustion in v1.
export const PI_SLUG_NAMESPACE_TO_ACCOUNT_KEY: Record<string, string> = {
  anthropic: "claudeAgent",
  "openai-codex": "codex",
};

/** Subscription account key for a pi model slug, or null when API-billed. */
export function accountKeyForModelSlug(slug: string): string | null {
  const slash = slug.indexOf("/");
  const namespace = slash === -1 ? slug : slug.slice(0, slash);
  return PI_SLUG_NAMESPACE_TO_ACCOUNT_KEY[namespace] ?? null;
}

/** The subscription account keys the health registry tracks (v1: the two pi
 * subscription pools). Derived from the namespace map's values so there is one
 * source of truth. */
const SUBSCRIPTION_ACCOUNT_KEYS = new Set(Object.values(PI_SLUG_NAMESPACE_TO_ACCOUNT_KEY));

/** The modelId (slug tail) of a pi model slug, or the whole string if unslashed. */
export function modelIdForModelSlug(slug: string): string {
  const slash = slug.indexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1);
}

/**
 * Resolve a full {@link ModelSelection} to the health-registry lookup pair
 * `(accountKey, modelId)`, handling BOTH routing shapes:
 *  - **pi driver** selections carry a `provider/modelId` slug in `model`, so the
 *    account comes from the slug namespace ({@link accountKeyForModelSlug}).
 *  - **direct** `codex`/`claudeAgent` driver selections carry a bare `modelId`
 *    in `model` and the subscription account IN `instanceId` (the registry key
 *    space is `providerInstanceId ?? providerName`). Using the slug alone here
 *    would return `accountKey: null` and wrongly treat an exhausted direct-
 *    driver thread as healthy (§6/§9).
 *
 * `isPiSubscriptionSlug` flags the pi-slug case — the only shape that tier-2
 * failover reroutes (direct drivers get classification + resume + UI only, §9),
 * so callers gate {@link resolveFailoverTarget} on it.
 */
export function subscriptionScopeForSelection(
  selection: {
    readonly instanceId: string;
    readonly model: string;
  },
  usageSourceInstances: ReadonlySet<string> = EMPTY_STRING_SET,
): {
  readonly accountKey: string | null;
  readonly modelId: string;
  readonly isPiSubscriptionSlug: boolean;
} {
  const slugAccount = accountKeyForModelSlug(selection.model);
  if (slugAccount !== null) {
    return {
      accountKey: slugAccount,
      modelId: modelIdForModelSlug(selection.model),
      isPiSubscriptionSlug: true,
    };
  }
  // An instance that declares its own `usageSources` (a router/pooled proxy)
  // meters exhaustion under its OWN instance id — the key the poller feeds and
  // the health registry marks — even when the slug namespace has no static
  // subscription mapping (e.g. `cliproxy/*`). This is what makes an exhausted
  // pooled instance actually gate fallback/resume/spawn, not just the pill.
  if (usageSourceInstances.has(selection.instanceId)) {
    return {
      accountKey: selection.instanceId,
      modelId: selection.model,
      isPiSubscriptionSlug: false,
    };
  }
  return {
    accountKey: SUBSCRIPTION_ACCOUNT_KEYS.has(selection.instanceId) ? selection.instanceId : null,
    modelId: selection.model,
    isPiSubscriptionSlug: false,
  };
}

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

/**
 * The set of provider-instance ids whose config declares subscription-usage
 * sources. Such instances meter exhaustion under their own instance id (see
 * {@link subscriptionScopeForSelection}); pass this into the resolver at every
 * exhaustion-consuming seam so a pooled instance's marks are actually honoured.
 */
export const usageSourceInstances = (
  providerInstances: Readonly<Record<string, { readonly usageSources?: ReadonlyArray<unknown> }>>,
): ReadonlySet<string> =>
  new Set(
    Object.entries(providerInstances).flatMap(([id, cfg]) =>
      (cfg.usageSources?.length ?? 0) > 0 ? [id] : [],
    ),
  );

/**
 * Compact, timezone-independent phrasing of when an exhaustion window resets,
 * for server-side control-plane messages (resume-wake reasons, spawn warnings)
 * whose reader's local timezone is unknown. Relative ("in ~2h 14m") rather than
 * an absolute clock time so it can never mislead across timezones. Null/invalid
 * `resetsAt` degrades to "when the limit resets".
 */
export function formatResetHint(resetsAt: string | null, nowMs: number): string {
  if (resetsAt === null) return "when the limit resets";
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return "when the limit resets";
  const deltaMs = resetMs - nowMs;
  if (deltaMs <= 0) return "shortly";
  const mins = Math.round(deltaMs / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `in ~${days}d ${hours % 24}h`;
  if (hours > 0) return `in ~${hours}h ${mins % 60}m`;
  return mins > 0 ? `in ~${mins}m` : "shortly";
}

/**
 * Subscription-limit (quota-exhaustion) error phrasing, distinct from the
 * transient capacity/plumbing regex. Matches the wording providers use when a
 * 5h/weekly window is spent — NOT generic 429/overload/"rate limit" (that is
 * transient and only counts as exhaustion when corroborated by an active mark,
 * see §5.3). Deliberately excludes bare "rate limit" phrasing so a plain
 * capacity 429 stays on the transient ladder unless a mark corroborates it.
 */
export const PI_QUOTA_ERROR_RE =
  /usage limit|weekly limit|monthly limit|quota|limit reached|reached your .*limit|out of.*(credits|quota)|resets? at|5.?hour limit/i;

/** True when an error message is quota-shaped on wording alone. */
export const classifiesAsQuota = (message: string): boolean => PI_QUOTA_ERROR_RE.test(message);

export const normaliseModelScopeName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function scopedDisplayNameToModelId(input: {
  readonly displayName: string;
  readonly modelSlugs: ReadonlyArray<string>;
  readonly accountKey?: string;
  readonly namespaces?: ReadonlyArray<string>;
}): string | null {
  const needle = normaliseModelScopeName(input.displayName);
  if (needle.length === 0) return null;
  const namespaces = new Set(
    input.namespaces ??
      (input.accountKey ? PI_SUBSCRIPTION_ACCOUNT_NAMESPACES[input.accountKey] : []),
  );
  const matches = new Set(
    input.modelSlugs.flatMap((slug) => {
      const slash = slug.indexOf("/");
      const provider = slash === -1 ? "" : slug.slice(0, slash);
      const modelId = slash === -1 ? slug : slug.slice(slash + 1);
      return (namespaces.size === 0 || namespaces.has(provider)) &&
        normaliseModelScopeName(modelId).includes(needle)
        ? [modelId]
        : [];
    }),
  );
  return matches.size === 1 ? (Array.from(matches)[0] ?? null) : null;
}
