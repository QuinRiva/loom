import { describe, expect, it } from "vite-plus/test";

import type { PathExistence } from "~/components/chat/usePathExistence";
import { resolveInlineCodeFileLinkMeta, resolveMarkdownFileLinkMeta } from "~/markdown-links";

import {
  collectMessageDirectoryBases,
  isAnchoredFileReference,
  selectUnanchoredBinding,
  unanchoredCandidates,
  unanchoredLocateReference,
} from "./unanchoredFileReferences";

const CWD = "/home/carl/w";
const FILE: PathExistence = { exists: true, isDirectory: false };
const DIRECTORY: PathExistence = { exists: true, isDirectory: true };
const MISSING: PathExistence = { exists: false, isDirectory: false };

function bind(
  span: string,
  directoryBases: string[],
  existence: Record<string, PathExistence>,
  located?: string | null,
) {
  const rootMeta = resolveInlineCodeFileLinkMeta(span, CWD);
  if (!rootMeta) throw new Error(`${span} did not resolve`);
  return selectUnanchoredBinding({
    candidates: unanchoredCandidates(span, rootMeta, directoryBases, CWD),
    lookupExistence: (filePath) => existence[filePath],
    located,
    span,
    cwd: CWD,
  });
}

describe("isAnchoredFileReference", () => {
  it("anchors only references that name one place", () => {
    for (const span of [
      "/abs/prices.json",
      "~/data/prices.json",
      "./prices.json",
      "../prices.json",
      "C:\\repo\\prices.json",
      "file:///abs/prices.json",
    ]) {
      expect(isAnchoredFileReference(span), span).toBe(true);
    }
    for (const span of ["prices.json", "src/models/chain_models.py:61", "Makefile:12"]) {
      expect(isAnchoredFileReference(span), span).toBe(false);
    }
  });
});

describe("collectMessageDirectoryBases", () => {
  it("keeps explicit directory references, in order, and never guesses one from a file", () => {
    const metas = [
      resolveInlineCodeFileLinkMeta("~/reports/gold/", CWD),
      resolveInlineCodeFileLinkMeta("/home/carl/data/_findings/", CWD),
      resolveMarkdownFileLinkMeta("/home/carl/data/_findings/", CWD),
      resolveInlineCodeFileLinkMeta("/home/carl/data/README.md", CWD),
    ].filter((meta) => meta !== null);
    expect(collectMessageDirectoryBases(metas)).toEqual([
      "/home/carl/reports/gold",
      "/home/carl/data/_findings",
    ]);
  });
});

describe("selectUnanchoredBinding", () => {
  const bases = ["/home/carl/data/_findings"];

  it("prefers the base directory, then message directories, in order", () => {
    expect(
      bind("verdict.md", bases, {
        "/home/carl/w/verdict.md": MISSING,
        "/home/carl/data/_findings/verdict.md": FILE,
      })?.filePath,
    ).toBe("/home/carl/data/_findings/verdict.md");
    expect(
      bind("verdict.md", bases, {
        "/home/carl/w/verdict.md": FILE,
        "/home/carl/data/_findings/verdict.md": FILE,
      })?.filePath,
    ).toBe("/home/carl/w/verdict.md");
  });

  it("waits on an unverified higher-priority candidate rather than binding past it", () => {
    expect(
      bind("verdict.md", bases, { "/home/carl/data/_findings/verdict.md": FILE }, null),
    ).toBeNull();
  });

  it("skips directories, since the chip is file-shaped", () => {
    expect(
      bind("verdict.md", bases, {
        "/home/carl/w/verdict.md": DIRECTORY,
        "/home/carl/data/_findings/verdict.md": FILE,
      })?.filePath,
    ).toBe("/home/carl/data/_findings/verdict.md");
  });

  it("falls back to the index's unique match and keeps the span's position", () => {
    const located = "/home/carl/w/jobs/lease/src/models/chain_models.py";
    const meta = bind(
      "src/models/chain_models.py:61",
      [],
      { "/home/carl/w/src/models/chain_models.py": MISSING },
      located,
    );
    expect(meta).toMatchObject({
      filePath: located,
      workspaceRelativePath: "jobs/lease/src/models/chain_models.py",
      line: 61,
    });
  });

  it("renders plain code — never missing — when nothing is confirmed", () => {
    const missing = { "/home/carl/w/prices.json": MISSING };
    // Index still answering, or no / several matches.
    expect(bind("prices.json", [], missing, undefined)).toBeNull();
    expect(bind("prices.json", [], missing, null)).toBeNull();
    // The index's match has since been stat'd gone.
    const located = "/home/carl/w/eval/prices.json";
    expect(bind("prices.json", [], { ...missing, [located]: MISSING }, located)).toBeNull();
  });
});

describe("unanchoredLocateReference", () => {
  it("drops the position suffix and normalises separators", () => {
    expect(unanchoredLocateReference("src\\models\\chain_models.py:61:4")).toBe(
      "src/models/chain_models.py",
    );
  });
});
