/**
 * The cross-vendor reroute decision for the single `providerFailover.fallbackTarget` slug: take it
 * only when its vendor differs from the exhausted model's, since CLI Proxy's account rotation
 * already covers same-vendor fallback inside a call.
 *
 * @module provider/failoverTarget
 */

/** The vendor part of a pi slug (`openai-codex/gpt-…` → `openai-codex`). */
const slugNamespace = (slug: string): string => {
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
