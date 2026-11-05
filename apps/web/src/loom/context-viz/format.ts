// loom: the context-viz figures' one number style: `8.8K`, `685K`, `1.02M`, `≈` on split estimates.
// Costs use `formatCostUsd` from `../costFormat`.
/** `412`, `8.8K`, `34.6K`, `685K`, `1.02M`, `1M`. */
export function formatContextTokens(tokens: number): string {
  const abs = Math.abs(tokens);
  if (abs < 1_000) return String(Math.round(tokens));
  if (abs < 100_000) return `${(tokens / 1_000).toFixed(1)}K`;
  if (abs < 1_000_000) return `${Math.round(tokens / 1_000)}K`;
  return `${Number((tokens / 1_000_000).toFixed(2))}M`;
}

/** A measured figure as is; a split estimate (`measured: false`) with `≈`. */
export const formatItemTokens = (item: { readonly tokens: number; readonly measured: boolean }) =>
  `${item.measured ? "" : "≈"}${formatContextTokens(item.tokens)}`;

/** `35.6%` of a whole; null when the whole is unknown. */
export const formatShare = (part: number, whole: number | null) =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : null;

/** `1 call`, `241 calls`. */
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A chart palette colour used as text, pulled toward the foreground so it clears 4.5:1 in both themes. */
export const paletteInk = (color: string) => `color-mix(in srgb, ${color} 60%, var(--foreground))`;
