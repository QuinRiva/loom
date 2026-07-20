/**
 * Which workspace files the web-runtime artifact viewer can render.
 *
 * v1 is HTML-only: the signed asset route also serves PDFs, but browsers'
 * built-in PDF viewers are unreliable inside a `sandbox` iframe without
 * `allow-same-origin` (which the viewer deliberately withholds). The query/
 * hash is stripped before testing, matching `isBrowserPreviewFile`.
 */
export const isArtifactViewerPath = (path: string): boolean =>
  /\.html?$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/**
 * Cache-bust a signed asset URL for a reload. Appends a unique `_r=<token>`
 * query param so the iframe fetches fresh bytes instead of the browser's
 * `Cache-Control: max-age` copy. The asset route matches on pathname only, so
 * the extra query is ignored server-side and relative subresources (resolved
 * against the path) still resolve. The returned value doubles as the iframe
 * `key`: changing it on every reload forces a remount so `onLoad` re-fires and
 * the loading overlay clears.
 */
export const buildArtifactFrameSrc = (url: string, reloadToken: number): string =>
  `${url}${url.includes("?") ? "&" : "?"}_r=${reloadToken}`;
