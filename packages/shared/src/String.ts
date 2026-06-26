/**
 * Convert arbitrary text into a URL/identifier-safe slug: lowercase, with runs
 * of non-alphanumeric characters collapsed to single hyphens and leading/
 * trailing hyphens trimmed. Returns `fallback` when nothing slug-able remains.
 */
export function slugify(text: string, fallback = "goal"): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}

export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}
