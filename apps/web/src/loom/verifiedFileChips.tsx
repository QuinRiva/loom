import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";

import {
  CHAT_FILE_TAG_CHIP_CLASS_NAME,
  FileTagChipContent,
  ThreadTagChipContent,
} from "~/components/chat/FileTagChip";
import { usePathExistence, type PathExistence } from "~/components/chat/usePathExistence";
import { useTheme } from "~/hooks/useTheme";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { resolveInlineCodeFileLinkMeta, type MarkdownFileLinkMeta } from "~/markdown-links";
import { useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import { extractMessagePathCandidates } from "./chatPathScan";

/**
 * Loom's file-chip seam over upstream's `fileLinkChip` renderer (slice 1 of the
 * chat-surface re-home). Upstream renders every syntactically resolvable path
 * as a live chip; a chip whose file has since been moved or deleted therefore
 * looks identical to one that works, and clicking it fails somewhere else. One
 * behaviour is re-attached here, and nothing else — an existing file renders
 * exactly upstream's chip:
 *
 *  - **existence verification** against the shared, batched stat store
 *    (`usePathExistence`): a path the server reports as gone renders a visibly
 *    "missing" chip instead of a dead link. An unverified path (no connected
 *    environment, e.g. the `/preview` harness, or a stat still in flight) keeps
 *    upstream's behaviour, so nothing flickers from live to missing and back.
 *
 * Artifact-viewer routing lives in upstream's `fileLinkChip` itself (an
 * `onOpenArtifact` primary-action override), so an artifact chip keeps the
 * upstream context menu.
 */
export type FileLinkChipRenderer = (
  fileLinkMeta: MarkdownFileLinkMeta,
  copyMarkdown: string,
  className?: string,
  mediaSource?: string,
) => ReactNode;

const MISSING_CHIP_CLASS_NAME =
  "chat-markdown-file-link opacity-70 line-through decoration-muted-foreground/60";
const MISSING_CHIP_TITLE = "Missing — moved or deleted?";

function MissingFileChip(props: {
  meta: MarkdownFileLinkMeta;
  copyMarkdown: string;
  className?: string | undefined;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(CHAT_FILE_TAG_CHIP_CLASS_NAME, MISSING_CHIP_CLASS_NAME, props.className)}
            data-markdown-copy={props.copyMarkdown}
            data-file-missing="true"
            aria-label={`${props.meta.basename} — ${MISSING_CHIP_TITLE}`}
          >
            <FileTagChipContent
              path={props.meta.filePath}
              label={`${props.meta.basename} · missing?`}
              theme={resolvedTheme}
              selectable
            />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-[min(40rem,calc(100vw-2rem))] text-[11px]">
        <div className="font-mono leading-tight wrap-anywhere">{props.meta.targetPath}</div>
        <div className="mt-0.5">{MISSING_CHIP_TITLE}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Wraps upstream's chip renderer. `metas` are the file links this message
 * already resolved, which is exactly the set worth keeping verified.
 */
export function useVerifiedFileLinkChip(input: {
  environmentId: EnvironmentId | null;
  metas: Iterable<MarkdownFileLinkMeta>;
  renderChip: FileLinkChipRenderer;
}): FileLinkChipRenderer {
  const { environmentId, renderChip } = input;
  const paths = useMemo(
    () => [...new Set([...input.metas].map((meta) => meta.filePath))],
    [input.metas],
  );
  const lookupExistence = usePathExistence(environmentId, paths);
  return useCallback(
    (fileLinkMeta, copyMarkdown, className, mediaSource) => {
      if (lookupExistence(fileLinkMeta.filePath)?.exists === false) {
        return (
          <MissingFileChip meta={fileLinkMeta} copyMarkdown={copyMarkdown} className={className} />
        );
      }
      return renderChip(fileLinkMeta, copyMarkdown, className, mediaSource);
    },
    [lookupExistence, renderChip],
  );
}

export interface ScannedPaths {
  /** Syntactic resolution only — says nothing about whether the file is there. */
  readonly resolveMeta: (rawPath: string) => MarkdownFileLinkMeta | null;
  /** Resolution plus verification; null unless the server confirms a file. */
  readonly resolveVerified: (rawPath: string) => MarkdownFileLinkMeta | null;
}

/**
 * With no connected environment (the `/preview` harness) nothing can be
 * verified, so a hit is linkable on the syntactic gate alone. Otherwise only a
 * confirmed regular file is: a directory is not, because the link opens the file
 * viewer.
 */
function isLinkableTarget(
  environmentId: EnvironmentId | null,
  existence: PathExistence | undefined,
): boolean {
  return environmentId === null || (existence?.exists === true && !existence.isDirectory);
}

/**
 * Per-hit verification for a leaf that rendered one scanned path. It subscribes
 * to the stat store itself rather than reading a resolver handed down from its
 * host: a path drawn as plain text has to upgrade to a link the moment
 * verification lands, and the host has no reason to re-render just then.
 */
export function useVerifiedScannedPath(
  environmentId: EnvironmentId | null,
  meta: MarkdownFileLinkMeta | null,
): MarkdownFileLinkMeta | null {
  const paths = useMemo(() => (meta ? [meta.filePath] : []), [meta]);
  const lookupExistence = usePathExistence(environmentId, paths);
  return meta && isLinkableTarget(environmentId, lookupExistence(meta.filePath)) ? meta : null;
}

/**
 * Resolver for loom's two *loose* path scanners — plain prose and inside fenced
 * code blocks. Their opposite polarity to {@link useVerifiedFileLinkChip} is the
 * whole point: a markdown link is an explicit authored reference, so it stays a
 * chip until proven missing, whereas a scanned substring is a guess and only
 * becomes clickable once the server confirms a **file** is there. Directories
 * stay plain text — upstream's chip is file-shaped (editor, media, file panel).
 *
 * Candidate discovery is bounded and block-aware
 * ({@link extractMessagePathCandidates}) and deferred entirely while streaming,
 * matching the renderers: re-scanning a growing message on every token would be
 * pure waste. With no connected environment (the `/preview` harness) nothing can
 * be verified, so hits render as chips on the syntactic gate alone.
 */
export function useScannedPathTargets(input: {
  environmentId: EnvironmentId | null;
  text: string;
  cwd: string | undefined;
  baseDir: string | undefined;
  isStreaming: boolean;
}): ScannedPaths {
  const { environmentId, cwd, baseDir, isStreaming, text } = input;
  const resolveMeta = useMemo(() => {
    const cache = new Map<string, MarkdownFileLinkMeta | null>();
    return (rawPath: string) => {
      const cached = cache.get(rawPath);
      if (cached !== undefined) return cached;
      const meta = resolveInlineCodeFileLinkMeta(rawPath, cwd, baseDir);
      cache.set(rawPath, meta);
      return meta;
    };
  }, [baseDir, cwd]);
  const paths = useMemo(
    () =>
      isStreaming
        ? []
        : [
            ...new Set(
              extractMessagePathCandidates(text).flatMap((candidate) => {
                const meta = resolveMeta(candidate);
                return meta ? [meta.filePath] : [];
              }),
            ),
          ],
    [isStreaming, resolveMeta, text],
  );
  const lookupExistence = usePathExistence(environmentId, paths);
  return useMemo(
    () => ({
      resolveMeta,
      resolveVerified: (rawPath: string) => {
        const meta = resolveMeta(rawPath);
        return meta && isLinkableTarget(environmentId, lookupExistence(meta.filePath))
          ? meta
          : null;
      },
    }),
    [environmentId, lookupExistence, resolveMeta],
  );
}

/**
 * `[Title](thread://<id>)` mentions — the wire form the provider projection
 * emits for a mentioned thread, and the form agents write when they name another
 * thread in prose.
 *
 * The chip navigates when the id resolves to a live thread in the message's own
 * environment (ids are only unique within one, so it is resolved by scoped ref).
 * It cannot when it does not: the shell snapshot and the thread-detail read both
 * filter `archived_at IS NULL`, so an archived, deleted or foreign thread has
 * nothing to open — navigating would bounce the human back to the thread list.
 * Those stay inert and say so on hover rather than pretending to be a link.
 */
export const THREAD_LINK_HREF_PREFIX = "thread://";

const UNRESOLVED_THREAD_CHIP_TITLE =
  "Not found here — this thread is archived, deleted, or in another environment.";

export function ThreadLinkChip({
  label,
  threadId,
  environmentId,
}: {
  label: string;
  threadId: string;
  environmentId: EnvironmentId | null;
}) {
  const navigate = useNavigate();
  const ref =
    environmentId === null || threadId.length === 0
      ? null
      : scopeThreadRef(environmentId, threadId as ThreadId);
  const shell = useThreadShell(ref);
  if (shell === null) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(CHAT_FILE_TAG_CHIP_CLASS_NAME, "cursor-help opacity-70")}
              aria-label={`${label} — ${UNRESOLVED_THREAD_CHIP_TITLE}`}
            />
          }
        >
          <ThreadTagChipContent label={label} />
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-[min(30rem,calc(100vw-2rem))] text-[11px]">
          {UNRESOLVED_THREAD_CHIP_TITLE}
        </TooltipPopup>
      </Tooltip>
    );
  }
  // The tooltip carries the thread's OWN title: the chip's label is whatever the
  // author wrote, which is often not what the thread is called.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Open ${shell.title}`}
            className={cn(CHAT_FILE_TAG_CHIP_CLASS_NAME, "cursor-pointer hover:underline")}
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(shell.environmentId, shell.id)),
              })
            }
          />
        }
      >
        <ThreadTagChipContent label={label} />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-[min(30rem,calc(100vw-2rem))] text-[11px]">
        {shell.title}
      </TooltipPopup>
    </Tooltip>
  );
}
