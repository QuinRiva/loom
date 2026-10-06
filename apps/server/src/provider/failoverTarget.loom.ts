/**
 * The cross-vendor reroute's one decision (pull 9 Phase 3 track 3c, the
 * strategy's failover ruling): a single `providerFailover.fallbackTarget` slug
 * replaces V1's chain grammar. The fallback is only worth taking when it is a
 * DIFFERENT vendor than the exhausted model — a same-vendor fallback is what
 * CLI Proxy's account rotation already does inside a call.
 *
 * @module provider/failoverTarget
 */

/** The vendor part of a pi slug (`openai-codex/gpt-…` → `openai-codex`). */
export const slugNamespace = (slug: string): string => {
  const slash = slug.indexOf("/");
  return slash === -1 ? slug : slug.slice(0, slash);
};

/**
 * The fallback slug when it is set, routable on the thread's provider
 * (`catalogue`), of another vendor than `intendedSlug`, and not itself
 * exhausted; otherwise `undefined`.
 */
export const resolveFailoverTarget = (input: {
  readonly intendedSlug: string;
  readonly fallbackTarget: string | null;
  readonly catalogue: ReadonlySet<string>;
  readonly isExhausted: (slug: string) => boolean;
}): string | undefined => {
  const target = input.fallbackTarget;
  return target !== null &&
    input.catalogue.has(target) &&
    slugNamespace(target) !== slugNamespace(input.intendedSlug) &&
    !input.isExhausted(target)
    ? target
    : undefined;
};
