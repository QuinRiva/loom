import { createContext } from "react";

import type { ScopedThreadRef } from "@t3tools/contracts";

import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

/**
 * Where the rendered document lives, so a block can resolve a document-relative path
 * and request a signed asset URL for the thread. Provided by `FilePreviewPanel`; absent
 * in tests and partial in `lint-plan.mjs` (`baseDir` only), so blocks must degrade.
 */
export interface PlanDocumentLocation {
  /** Absolute directory holding the document — the base for a relative `src`. */
  baseDir: string;
  /** Project root, for media labels and "open file" paths (which are workspace-
   * relative, not document-relative). Absent in the headless renderer. */
  cwd?: string | undefined;
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
