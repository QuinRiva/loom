import {
  directoryBasesFromPaths,
  isAnchoredFileReference,
} from "@t3tools/client-runtime/unanchored-file-references";
import {
  inlineCodeFilePathCandidate,
  normalizeMarkdownLinkDestination,
} from "@t3tools/shared/markdownLinks";

import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { resolveFileLinkPath, resolveWorkspaceFilePath } from "../files/filePath";

/** A tapped relative file link that the root alone cannot settle. */
export interface UnanchoredFileLink {
  readonly reference: string;
  readonly rootPath: string;
  /** `:line[:col]` to carry onto whatever the lookup finds. */
  readonly position: string;
}

export function unanchoredFileLink(
  href: string,
  workspaceRoot: string | null | undefined,
): UnanchoredFileLink | null {
  const presentation = resolveMarkdownLinkPresentation(href);
  if (!workspaceRoot || presentation.kind !== "file") return null;
  if (isAnchoredFileReference(presentation.path) || /[\\/]$/.test(presentation.path)) return null;
  const relative = resolveFileLinkPath(workspaceRoot, presentation.path);
  if (relative === null) return null;
  const { line, column } = presentation;
  return {
    reference: relative,
    rootPath: resolveWorkspaceFilePath(workspaceRoot, relative),
    position: line === undefined ? "" : `:${line}${column === undefined ? "" : `:${column}`}`,
  };
}

const FENCED_BLOCK = /^(```|~~~)[\s\S]*?^\1/gm;
const INLINE_CODE = /`([^`\n]+)`/g;
const LINK_DESTINATION = /\]\(\s*(<[^>\n]+>|[^)\s]+)/g;

/** The folders a message names with a trailing separator, as web collects them. */
export function messageDirectoryBases(markdown: string, workspaceRoot: string): string[] {
  const prose = markdown.replace(FENCED_BLOCK, "");
  const targets = [
    ...[...prose.matchAll(INLINE_CODE)].flatMap(([, span]) => {
      const candidate = inlineCodeFilePathCandidate(span!);
      return candidate === null ? [] : [candidate];
    }),
    ...[...prose.matchAll(LINK_DESTINATION)].map(([, destination]) =>
      normalizeMarkdownLinkDestination(destination!),
    ),
  ];
  return directoryBasesFromPaths(
    targets.flatMap((target) => {
      if (!/[\\/]$/.test(target) || /^[A-Za-z][\w+.-]*:/.test(target)) return [];
      const resolved = resolveFileLinkPath(workspaceRoot, target);
      return resolved === null ? [] : [`${resolveWorkspaceFilePath(workspaceRoot, resolved)}/`];
    }),
  );
}
