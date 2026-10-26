/**
 * Format a dollar cost for loom's workstream surfaces: `$1.20`, `$0.42`, `<$0.01` for tiny non-zero
 * spend, and `null` (render nothing) for an unknown or zero cost. The figure is the provider's own;
 * we never price tokens ourselves.
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
