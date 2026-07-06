/**
 * Shared provider-failover constants and helpers (tier-2 exhaustion failover).
 *
 * Single source of truth for the built-in fallback chains, consumed by both the
 * settings chain editor (`apps/web`) and the chunk-C routing resolver
 * (`resolveFailoverTarget` in the server pi driver). Keeping the defaults here
 * means the editor seeds and the routing fallback can never drift.
 *
 * Chain grammar (persisted in `ServerSettings.providerFailover.chains`):
 *   - keys   : an exact pi slug ("anthropic/claude-fable-5") OR a namespace
 *              wildcard ("openai-codex/*").
 *   - values : ordered target entries, each either a concrete pi slug
 *              ("anthropic/claude-opus-4-8") OR a bare namespace
 *              ("google-vertex-claude") meaning "same model on that pool" — the
 *              resolver substitutes the exhausted slug's modelId (§5.2).
 */

/** pi slug namespace → human backend label (mirrors PiDriver's PI_BACKEND_LABELS). */
export const PI_NAMESPACE_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  bedrock: "Bedrock",
  "google-vertex": "Google Vertex (Gemini)",
  "google-vertex-claude": "Google Vertex",
  openai: "OpenAI",
  "openai-codex": "Codex",
};

/**
 * Built-in fallback chains (§5.2). Seed the settings editor and act as the
 * routing fallback for any key the user has not overridden. A bare-namespace
 * target ("google-vertex-claude") is the "same model, other pool" entry the
 * resolver expands with the exhausted slug's modelId; the resolver's
 * skip-exhausted walk covers the model-scoped vs account-wide distinction (a
 * dead account-wide Anthropic simply skips the opus entry and lands on Vertex).
 */
export const DEFAULT_FAILOVER_CHAINS: Record<string, ReadonlyArray<string>> = {
  "openai-codex/*": ["anthropic/claude-opus-4-8", "google-vertex-claude/claude-opus-4-8"],
  "anthropic/*": ["google-vertex-claude", "anthropic/claude-opus-4-8"],
  "google-vertex-claude/*": ["anthropic"],
};

/** The namespace part of a pi slug, or the whole string when it is bare. */
export const failoverNamespaceOf = (slug: string): string => {
  const slash = slug.indexOf("/");
  return slash === -1 ? slug : slug.slice(0, slash);
};

/** A target entry is "same model on a pool" when it carries no `/modelId`. */
export const isSameModelTarget = (target: string): boolean => !target.includes("/");

export const failoverNamespaceLabel = (namespace: string): string =>
  PI_NAMESPACE_LABELS[namespace] ?? namespace;

/**
 * Human label for a chain target entry: a bare namespace reads as
 * "Same model · <pool>"; a concrete slug uses the catalogue display name when
 * one is known, else the slug itself.
 */
export const describeFailoverTarget = (
  target: string,
  nameBySlug: ReadonlyMap<string, string>,
): string =>
  isSameModelTarget(target)
    ? `Same model · ${failoverNamespaceLabel(target)}`
    : (nameBySlug.get(target) ?? target);
