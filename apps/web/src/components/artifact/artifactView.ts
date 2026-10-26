/**
 * HTML only: the signed asset route also serves PDFs, but browsers' built-in PDF viewers
 * are unreliable inside a `sandbox` iframe without `allow-same-origin`, which the viewer
 * deliberately withholds. Query and hash are stripped, matching `isBrowserPreviewFile`.
 */
export const isArtifactViewerPath = (path: string): boolean =>
  /\.html?$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/**
 * `_r=<token>` defeats the browser's `Cache-Control: max-age` copy; the asset route matches
 * on pathname only, so the server ignores it and relative subresources still resolve. The
 * result doubles as the iframe `key`, so each reload remounts and `onLoad` re-fires to clear
 * the loading overlay.
 */
export const buildArtifactFrameSrc = (url: string, reloadToken: number): string =>
  `${url}${url.includes("?") ? "&" : "?"}_r=${reloadToken}`;
