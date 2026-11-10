import {
  directoryBasesFromPaths,
  isAnchoredFileReference,
  unanchoredCandidatePaths,
} from "@t3tools/client-runtime/unanchored-file-references";
import { stripRepeatedWorkspacePrefix } from "@t3tools/client-runtime/workspace-basename-lookup";
import { renderCodexInlineDirectivesAsMarkdown } from "@t3tools/shared/codexMarkdownDirectives";
import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
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

/** The folders a message names with a trailing separator, collected as web collects them. */
export function messageDirectoryBases(markdown: string, workspaceRoot: string): string[] {
  const targets = [
    ...extractInlineCodeSpans(markdown).flatMap((span) => inlineCodeFilePathCandidate(span) ?? []),
    ...extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(markdown)).map(
      normalizeMarkdownLinkDestination,
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

/**
 * Stat candidates for a tap, in the shared order. A path that repeats a subfolder project's own
 * prefix (`apps/web/src/x.ts` in a project rooted at `apps/web`) is also tried without it, as web
 * does when it opens a markdown link.
 */
export function messageFileCandidates(
  link: UnanchoredFileLink,
  markdown: string | undefined,
  workspaceRoot: string,
): string[] {
  const stripped = stripRepeatedWorkspacePrefix(link.reference, workspaceRoot);
  const [root, ...named] = unanchoredCandidatePaths(
    link.rootPath,
    link.reference,
    markdown === undefined ? [] : messageDirectoryBases(markdown, workspaceRoot),
  );
  return [
    ...new Set([
      root!,
      ...(stripped === null ? [] : [resolveWorkspaceFilePath(workspaceRoot, stripped)]),
      ...named,
    ]),
  ];
}
