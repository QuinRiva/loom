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
import {
  refreshPathExistence,
  usePathExistence,
  type PathExistence,
} from "~/components/chat/usePathExistence";
import { useTheme } from "~/hooks/useTheme";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { resolveInlineCodeFileLinkMeta, type MarkdownFileLinkMeta } from "~/markdown-links";
import { basenameOfPath } from "~/pierre-icons";
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
 *  - **click-time re-verification** ({@link verifyChipTargetBeforeOpen}): the
 *    store only revalidates at its TTL, so a chip can be clicked inside the
 *    window where its file has already moved. The click re-stats the path, and
 *    a gone file flips the chip and toasts instead of opening nothing "as if it
 *    were a bug".
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
 * Re-verify a chip target at the moment it is clicked. `false` means do not
 * open: the store now holds `exists: false`, which re-renders that chip as
 * {@link MissingFileChip}, and the toast says why. A path that cannot be
 * verified — no connected environment, or a failed stat — opens as before,
 * because an unhealthy RPC must not block a working link.
 */
export async function verifyChipTargetBeforeOpen(
  environmentId: EnvironmentId | null,
  filePath: string,
): Promise<boolean> {
  if (environmentId === null) return true;
  const existence = await refreshPathExistence(environmentId, filePath);
  if (existence?.exists !== false) return true;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: `${basenameOfPath(filePath)} has moved or been deleted`,
      description: `${filePath} is no longer there — it existed when this was written.`,
    }),
  );
  return false;
}

/**
 * One chip, subscribed to its own path. The subscription belongs here rather
 * than to the hosting message for the same reason the scanned-path leaf owns
 * one: a result that lands — or changes — after the message rendered has to
 * repaint the chip, and the host has no reason to re-render just then.
 * Registration is ref-counted and stats are batched per environment, so N chips
 * still cost one RPC, and only the chips repaint rather than whole messages.
 */
function VerifiedFileChip(props: {
  environmentId: EnvironmentId | null;
  meta: MarkdownFileLinkMeta;
  copyMarkdown: string;
  className?: string | undefined;
  mediaSource?: string | undefined;
  renderChip: FileLinkChipRenderer;
}) {
  const paths = useMemo(() => [props.meta.filePath], [props.meta.filePath]);
  const lookupExistence = usePathExistence(props.environmentId, paths);
  return lookupExistence(props.meta.filePath)?.exists === false ? (
    <MissingFileChip
      meta={props.meta}
      copyMarkdown={props.copyMarkdown}
      className={props.className}
    />
  ) : (
    props.renderChip(props.meta, props.copyMarkdown, props.className, props.mediaSource)
  );
}

/** Wraps upstream's chip renderer so every chip it renders stays verified. */
export function useVerifiedFileLinkChip(input: {
  environmentId: EnvironmentId | null;
  renderChip: FileLinkChipRenderer;
}): FileLinkChipRenderer {
  const { environmentId, renderChip } = input;
  return useCallback(
    (fileLinkMeta, copyMarkdown, className, mediaSource) => (
      <VerifiedFileChip
        environmentId={environmentId}
        meta={fileLinkMeta}
        copyMarkdown={copyMarkdown}
        className={className}
        mediaSource={mediaSource}
        renderChip={renderChip}
      />
    ),
    [environmentId, renderChip],
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
 *
 * A markdown surface with no environment at all (a file or composer-context
 * preview) is a different fact and gets different copy: nothing was looked up,
 * so claiming the thread is gone would be a lie.
 */
export const THREAD_LINK_HREF_PREFIX = "thread://";

const UNRESOLVED_THREAD_CHIP_TITLE =
  "Not found here — this thread is archived, deleted, or in another environment.";

const UNSCOPED_THREAD_CHIP_TITLE =
  "Not linkable here — this view is not tied to an environment, so the thread cannot be opened.";

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
    const inertTitle = ref === null ? UNSCOPED_THREAD_CHIP_TITLE : UNRESOLVED_THREAD_CHIP_TITLE;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(CHAT_FILE_TAG_CHIP_CLASS_NAME, "cursor-help opacity-70")}
              aria-label={`${label} — ${inertTitle}`}
            />
          }
        >
          <ThreadTagChipContent label={label} />
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-[min(30rem,calc(100vw-2rem))] text-[11px]">
          {inertTitle}
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
