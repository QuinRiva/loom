/**
 * Format a dollar cost for loom's workstream surfaces: `$1.20`, `$0.42`,
 * `<$0.01` for tiny non-zero spend, and `null` (render nothing) when there is
 * no known cost (null/unknown or 0 — e.g. providers that report no cost). The
 * figure is the provider's own authoritative number; we never price tokens
 * ourselves.
 *
 * Lived in `lib/contextWindow.ts` until the composer meter became upstream's;
 * it now sits here with all its consumers — the workstream panel, quick facts,
 * the active strip, and the meter's spend block (`loom/contextCost.ts`).
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
