/**
 * Format a dollar cost for loom's workstream surfaces: `$1.20`, `$0.42`,
 * `<$0.01` for tiny non-zero spend, and `null` (render nothing) when there is
 * no known cost (null/unknown or 0 — e.g. providers that report no cost). The
 * figure is the provider's own authoritative number; we never price tokens
 * ourselves.
 *
 * Lived in `lib/contextWindow.ts` while loom's composer meter rendered a spend
 * roll-up. That meter is upstream's now and shows context utilisation only, so
 * the helper moved here with its remaining consumers (the workstream panel,
 * quick facts and the active strip).
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
