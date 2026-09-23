import { createContext } from "react";

import type { ScopedThreadRef } from "@t3tools/contracts";

import { resolvePathLinkTarget } from "~/terminal-links";

/**
 * Where the document being rendered lives, so a block can resolve a path the
 * author wrote *relative to the document* (`<Image src="shots/before.png">`).
 * The renderer runs in the browser and the file lives on the environment host,
 * so this carries exactly what the app's other file-relative image surface
 * (`FileMarkdownPreview` → `ChatMarkdown`) needs: the document's directory, and
 * the thread whose identity a signed asset URL is issued against.
 *
 * Provided by `FilePreviewPanel`. Absent in the headless renderer
 * (`scripts/lint-plan.mjs` provides `baseDir` only, no thread) and in component
 * tests — a block MUST degrade rather than throw when it is missing.
 */
export interface PlanDocumentLocation {
  /** Absolute directory holding the document — the base for a relative `src`. */
  baseDir: string;
  /** Thread the preview belongs to; absent outside the app, where an image
   * falls back to a plain `file://` src that only a local viewer can load. */
  threadRef?: ScopedThreadRef | undefined;
}

export const PlanDocumentContext = createContext<PlanDocumentLocation | null>(null);

/** The absolute directory holding a workspace-relative document. */
export function documentBaseDir(relativePath: string, cwd: string): string {
  const lastSeparator = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  return lastSeparator >= 0
    ? resolvePathLinkTarget(relativePath.slice(0, lastSeparator), cwd)
    : cwd;
}
