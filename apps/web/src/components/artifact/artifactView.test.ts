import { describe, expect, it } from "vite-plus/test";

import { buildArtifactFrameSrc, isArtifactViewerPath } from "./artifactView";

describe("isArtifactViewerPath", () => {
  it("accepts .html and .htm entry files regardless of case", () => {
    expect(isArtifactViewerPath("experiments/mockup.html")).toBe(true);
    expect(isArtifactViewerPath("demo/index.htm")).toBe(true);
    expect(isArtifactViewerPath("REPORT.HTML")).toBe(true);
  });

  it("ignores a trailing query or hash", () => {
    expect(isArtifactViewerPath("demo/index.html?v=2")).toBe(true);
    expect(isArtifactViewerPath("demo/index.html#section")).toBe(true);
  });

  it("rejects non-HTML files, including PDFs (excluded from v1)", () => {
    expect(isArtifactViewerPath("docs/report.pdf")).toBe(false);
    expect(isArtifactViewerPath("src/index.ts")).toBe(false);
    expect(isArtifactViewerPath("styles/app.css")).toBe(false);
    expect(isArtifactViewerPath("notes.html.bak")).toBe(false);
    expect(isArtifactViewerPath("archive.htmlx")).toBe(false);
  });
});

describe("buildArtifactFrameSrc", () => {
  const url = "https://env.example/api/assets/tok3n/index.html";

  it("changes on every reload so the iframe key/src forces a fresh load", () => {
    // Same signed URL (the atom returns a cached member) but successive reload
    // tokens must yield distinct values, or the iframe never remounts and the
    // loading overlay would hang forever.
    expect(buildArtifactFrameSrc(url, 0)).not.toBe(buildArtifactFrameSrc(url, 1));
    expect(buildArtifactFrameSrc(url, 1)).not.toBe(buildArtifactFrameSrc(url, 2));
  });

  it("appends the cache-busting token as a query param", () => {
    expect(buildArtifactFrameSrc(url, 2)).toBe(`${url}?_r=2`);
  });

  it("joins with & when the URL already has a query string", () => {
    expect(buildArtifactFrameSrc(`${url}?v=1`, 3)).toBe(`${url}?v=1&_r=3`);
  });
});
