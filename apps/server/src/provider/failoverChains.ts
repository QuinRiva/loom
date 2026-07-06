/**
 * Tier-2 failover chain resolution (§5.2) — pure, unit-tested routing logic.
 *
 * Given an exhausted pi model slug, walk an ordered chain of candidate targets
 * and return the first one that is present in the live catalogue and whose own
 * account/model is not itself exhausted or paused. The chain comes from a
 * user override (exact slug key, then namespace wildcard key) or, failing that,
 * the shared built-in default keyed by the exhausted slug's namespace.
 *
 * Kept side-effect-free: the health state arrives as a synchronous `isExhausted`
 * predicate (derived by the caller from a {@link ProviderHealthRegistry}
 * snapshot, which already folds in soft-paused accounts), so the whole
 * branch-heavy resolution is trivially testable.
 *
 * @module failoverChains
 */
import { DEFAULT_FAILOVER_CHAINS } from "@t3tools/shared/providerFailover";

import { accountKeyForModelSlug } from "./exhaustionMapping.ts";

/** Placeholder in a chain target meaning "the exhausted slug's own modelId". */
const MODEL_PLACEHOLDER = "<m>";

const namespaceOf = (slug: string): string => {
  const slash = slug.indexOf("/");
  return slash === -1 ? slug : slug.slice(0, slash);
};

const modelIdOf = (slug: string): string => {
  const slash = slug.indexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1);
};

/**
 * Resolve a chain target into a concrete slug, substituting the exhausted
 * slug's modelId for namespace-only targets: an explicit `<m>` placeholder, a
 * bare namespace ("google-vertex-claude"), or a namespace wildcard
 * ("google-vertex-claude/*").
 */
const substituteModelId = (target: string, modelId: string): string => {
  if (target.includes(MODEL_PLACEHOLDER)) return target.replaceAll(MODEL_PLACEHOLDER, modelId);
  const slash = target.indexOf("/");
  if (slash === -1) return `${target}/${modelId}`;
  if (target.slice(slash + 1) === "*") return `${target.slice(0, slash)}/${modelId}`;
  return target;
};

const chainFor = (
  slug: string,
  namespace: string,
  chains: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
): ReadonlyArray<string> =>
  chains?.[slug] ?? chains?.[`${namespace}/*`] ?? DEFAULT_FAILOVER_CHAINS[`${namespace}/*`] ?? [];

/**
 * First healthy failover target for an exhausted slug, or `undefined` when the
 * whole chain is exhausted/paused/absent-from-catalogue. `isExhausted` must
 * already fold in soft-paused accounts (the registry snapshot does). Only ever
 * called for a slug that is itself exhausted.
 */
export function resolveFailoverTarget(input: {
  readonly slug: string;
  readonly catalogue: ReadonlySet<string>;
  readonly isExhausted: (accountKey: string, modelId?: string) => boolean;
  readonly chains?: Readonly<Record<string, ReadonlyArray<string>>>;
}): string | undefined {
  const namespace = namespaceOf(input.slug);
  const modelId = modelIdOf(input.slug);
  for (const raw of chainFor(input.slug, namespace, input.chains)) {
    const target = substituteModelId(raw, modelId);
    if (target === input.slug || !input.catalogue.has(target)) continue;
    const targetAccount = accountKeyForModelSlug(target);
    if (targetAccount !== null && input.isExhausted(targetAccount, modelIdOf(target))) continue;
    return target;
  }
  return undefined;
}
