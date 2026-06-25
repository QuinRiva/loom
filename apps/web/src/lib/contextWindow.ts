import type {
  OrchestrationThreadActivity,
  ThreadId,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import {
  childrenOf,
  descendantsOf,
  subtreeCostOf,
  type CostGraphNode,
} from "@t3tools/shared/workstreamGraph";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

/** One branch's contribution to the subtree cost (its own subtree total). */
export interface ContextCostChild {
  readonly id: ThreadId;
  readonly title: string;
  readonly costUsd: number;
}

/** The cost figures the meter shows: this thread's own spend, its whole subtree, and the branch breakdown. */
export interface ContextCostSummary {
  readonly ownCostUsd: number;
  readonly subtreeCostUsd: number;
  readonly hasDescendants: boolean;
  readonly descendantCount: number;
  /** Per-direct-child subtree totals (>0 only), most expensive first. */
  readonly children: ReadonlyArray<ContextCostChild>;
}

/**
 * Roll up the active thread's cost from the workstream graph the client already
 * holds: own spend plus the subtree total (so the root orchestrator shows the
 * whole workstream's spend), with a per-branch breakdown for the popover. Pure;
 * delegates the lineage walk + summation to the shared `subtreeCostOf`.
 */
export function deriveContextCostSummary<T extends CostGraphNode & { readonly title: string }>(
  activeThreadId: ThreadId | null,
  threads: ReadonlyArray<T>,
): ContextCostSummary | null {
  if (activeThreadId === null) {
    return null;
  }
  const descendants = descendantsOf(activeThreadId, threads);
  const ownCostUsd = threads.find((thread) => thread.id === activeThreadId)?.cumulativeCostUsd ?? 0;
  const children = childrenOf(activeThreadId, threads)
    .map((child) => ({
      id: child.id,
      title: child.title,
      costUsd: subtreeCostOf(child.id, threads),
    }))
    .filter((child) => child.costUsd > 0)
    .sort((left, right) => right.costUsd - left.costUsd);
  return {
    ownCostUsd,
    subtreeCostUsd: subtreeCostOf(activeThreadId, threads),
    hasDescendants: descendants.length > 0,
    descendantCount: descendants.length,
    children,
  };
}

/**
 * Format a dollar cost for the meter: `$1.20`, `$0.42`, `<$0.01` for tiny
 * non-zero spend, and `null` (render nothing) when there is no known cost
 * (null/unknown or 0 — e.g. providers that report no cost). The figure is the
 * provider's own authoritative number; we never price tokens ourselves.
 */
export function formatCostUsd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return "<$0.01";
  }
  return `$${value.toFixed(2)}`;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
