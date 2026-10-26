import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { FileTagChipContent, ThreadTagChipContent } from "~/components/chat/FileTagChip";
import { ContextChip } from "~/components/ContextChip";
import {
  refreshPathExistence,
  revalidatePathExistence,
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
import {
  collectMessageDirectoryBases,
  locatedFileStore,
  locateFileKey,
  selectUnanchoredBinding,
  unanchoredCandidates,
  unanchoredLocateReference,
} from "./unanchoredFileReferences";

/**
 * Loom's seam over upstream's `fileLinkChip`: a chip whose file the server reports
 * gone renders "missing"; an unverified path keeps upstream's chip so nothing
 * flickers. The click re-stats inside the store's TTL window, and hovering a
 * missing chip marks it due so a file that came back recovers at once.
 */
export type FileLinkChipRenderer = (
  fileLinkMeta: MarkdownFileLinkMeta,
  copyMarkdown: string,
  className?: string,
  mediaSource?: string,
) => ReactNode;

const MISSING_CHIP_CLASS_NAME =
  "chat-markdown-file-link opacity-70 line-through decoration-muted-foreground/60";
const MISSING_CHIP_TITLE = "Missing (moved or deleted?)";

function MissingFileChip(props: {
  environmentId: EnvironmentId | null;
  meta: MarkdownFileLinkMeta;
  copyMarkdown: string;
  className?: string | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const { environmentId, meta } = props;
  // The way back: a file that returns is otherwise only noticed at the store's
  // TTL, and hovering is exactly what a human does when they doubt this chip.
  const recheck = () => {
    if (environmentId !== null) revalidatePathExistence(environmentId, meta.filePath);
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="mention"
            className={cn(MISSING_CHIP_CLASS_NAME, "select-text", props.className)}
            data-markdown-copy={props.copyMarkdown}
            data-file-missing="true"
            aria-label={`${props.meta.basename}: ${MISSING_CHIP_TITLE}`}
            onPointerEnter={recheck}
          >
            <FileTagChipContent
              path={props.meta.filePath}
              label={`${props.meta.basename} · missing?`}
              theme={resolvedTheme}
            />
          </ContextChip>
        }
      />
      <TooltipPopup side="top" className="max-w-[min(40rem,calc(100vw-2rem))]">
        <div className="font-mono leading-tight wrap-anywhere">{props.meta.targetPath}</div>
        <div className="mt-0.5">{MISSING_CHIP_TITLE}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * `false` means do not open: the store now holds `exists: false` and the toast
 * says why. An unverifiable path (no environment, failed stat) opens, because an
 * unhealthy RPC must not block a working link.
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
      description: `${filePath} is no longer there. It existed when this was written.`,
    }),
  );
  return false;
}

/**
 * Each chip subscribes to its own path so a late result repaints the chip, not
 * the hosting message. Registration is ref-counted and stats are batched per
 * environment, so N chips cost one RPC.
 */
function VerifiedFileChip(props: {
  environmentId: EnvironmentId | null;
  meta: MarkdownFileLinkMeta;
  copyMarkdown: string;
  className?: string | undefined;
  mediaSource?: string | undefined;
  renderChip: FileLinkChipRenderer;
}) {
  const paths = [props.meta.filePath];
  const lookupExistence = usePathExistence(props.environmentId, paths);
  return lookupExistence(props.meta.filePath)?.exists === false ? (
    <MissingFileChip
      environmentId={props.environmentId}
      meta={props.meta}
      copyMarkdown={props.copyMarkdown}
      className={props.className}
    />
  ) : (
    props.renderChip(props.meta, props.copyMarkdown, props.className, props.mediaSource)
  );
}

/**
 * Wraps upstream's chip renderer so every chip it renders stays verified. A
 * plain factory: the calling component's compiler cache keeps its identity.
 */
export function makeVerifiedFileLinkChip(input: {
  environmentId: EnvironmentId | null;
  renderChip: FileLinkChipRenderer;
}): FileLinkChipRenderer {
  const { environmentId, renderChip } = input;
  return (fileLinkMeta, copyMarkdown, className, mediaSource) => (
    <VerifiedFileChip
      environmentId={environmentId}
      meta={fileLinkMeta}
      copyMarkdown={copyMarkdown}
      className={className}
      mediaSource={mediaSource}
      renderChip={renderChip}
    />
  );
}

/**
 * One unanchored inline-code span: plain code until a candidate or the index
 * confirms a file, then upstream's chip. All lookups are issued together so the
 * chip costs one coalesced round of RPCs, not a chain.
 */
function UnanchoredFileChip(props: {
  environmentId: EnvironmentId | null;
  span: string;
  rootMeta: MarkdownFileLinkMeta;
  directoryBases: readonly string[];
  cwd: string | undefined;
  renderChip: FileLinkChipRenderer;
  fallback: ReactNode;
}) {
  const { environmentId, span, rootMeta, directoryBases, cwd } = props;
  const candidates = unanchoredCandidates(span, rootMeta, directoryBases, cwd);
  const locateKey = cwd ? locateFileKey(cwd, unanchoredLocateReference(span)) : null;
  const lookupLocated = locatedFileStore.useLookup(environmentId, locateKey ? [locateKey] : []);
  const located = locateKey ? lookupLocated(locateKey) : null;
  // The index's answer is also stat'd so a file deleted since it was indexed
  // drops back to plain code; the binding does not wait on that stat.
  const paths = [...candidates.map((meta) => meta.filePath), ...(located ? [located] : [])];
  const lookupExistence = usePathExistence(environmentId, paths);
  // No connected environment (the `/preview` harness): nothing can be
  // verified, so the syntactic resolution renders as before.
  const meta =
    environmentId === null
      ? rootMeta
      : selectUnanchoredBinding({ candidates, lookupExistence, located, span, cwd });
  return meta ? props.renderChip(meta, `\`${span}\``, undefined, meta.filePath) : props.fallback;
}

/**
 * The directories one message names, as a content key: a streaming message
 * rebuilds its meta maps per token, and a string keeps the renderer below (and
 * so every span) unchanged until the directories themselves change.
 */
export const messageDirectoryBasesKey = (
  inlineCodeMetas: ReadonlyMap<string, MarkdownFileLinkMeta>,
  linkMetas: ReadonlyMap<string, MarkdownFileLinkMeta>,
) => collectMessageDirectoryBases([...inlineCodeMetas.values(), ...linkMetas.values()]).join("\n");

/**
 * Renderer for unanchored inline-code spans, bound to one message's directory
 * bases (`messageDirectoryBasesKey`). `renderChip` is upstream's unverified
 * chip — this path is already verified, and an unanchored guess must never
 * render "missing?". A plain factory, like `makeVerifiedFileLinkChip`.
 */
export function makeUnanchoredInlineCodeChip(input: {
  environmentId: EnvironmentId | null;
  cwd: string | undefined;
  basesKey: string;
  renderChip: FileLinkChipRenderer;
}): (span: string, rootMeta: MarkdownFileLinkMeta, fallback: ReactNode) => ReactNode {
  const { environmentId, cwd, basesKey, renderChip } = input;
  const directoryBases = basesKey ? basesKey.split("\n") : [];
  return (span, rootMeta, fallback) => (
    <UnanchoredFileChip
      environmentId={environmentId}
      span={span}
      rootMeta={rootMeta}
      directoryBases={directoryBases}
      cwd={cwd}
      renderChip={renderChip}
      fallback={fallback}
    />
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
  const paths = meta ? [meta.filePath] : [];
  const lookupExistence = usePathExistence(environmentId, paths);
  return meta && isLinkableTarget(environmentId, lookupExistence(meta.filePath)) ? meta : null;
}

/** One cache per (cwd, baseDir): the compiler re-creates it only when either changes. */
function cachedMetaResolver(cwd: string | undefined, baseDir: string | undefined) {
  const cache = new Map<string, MarkdownFileLinkMeta | null>();
  return (rawPath: string) => {
    const cached = cache.get(rawPath);
    if (cached !== undefined) return cached;
    const meta = resolveInlineCodeFileLinkMeta(rawPath, cwd, baseDir);
    cache.set(rawPath, meta);
    return meta;
  };
}

/**
 * Resolver for the loose prose and fenced-block path scanners: the opposite
 * polarity to {@link makeVerifiedFileLinkChip}, since a scanned substring is a
 * guess and becomes clickable only once the server confirms a file. Scanning is
 * deferred while streaming; with no environment, hits pass on syntax alone.
 */
export function useScannedPathTargets(input: {
  environmentId: EnvironmentId | null;
  text: string;
  cwd: string | undefined;
  baseDir: string | undefined;
  isStreaming: boolean;
}): ScannedPaths {
  const { environmentId, cwd, baseDir, isStreaming, text } = input;
  const resolveMeta = cachedMetaResolver(cwd, baseDir);
  const paths = isStreaming
    ? []
    : [
        ...new Set(
          extractMessagePathCandidates(text).flatMap((candidate) => {
            const meta = resolveMeta(candidate);
            return meta ? [meta.filePath] : [];
          }),
        ),
      ];
  const lookupExistence = usePathExistence(environmentId, paths);
  return {
    resolveMeta,
    resolveVerified: (rawPath: string) => {
      const meta = resolveMeta(rawPath);
      return meta && isLinkableTarget(environmentId, lookupExistence(meta.filePath)) ? meta : null;
    },
  };
}

/**
 * Thread chip for Loom's workstream rows. It navigates only when the id resolves
 * to a live thread in the message's own environment: shell and detail reads skip
 * archived rows, so an archived, deleted or foreign thread stays inert and says
 * so on hover. With no environment at all nothing was looked up, hence other copy.
 */
const UNRESOLVED_THREAD_CHIP_TITLE =
  "Not found here: this thread is archived, deleted, or in another environment.";

const UNSCOPED_THREAD_CHIP_TITLE =
  "Not linkable here: this view is not tied to an environment, so the thread cannot be opened.";

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
            <ContextChip
              kind="mention"
              className="cursor-help opacity-70"
              aria-label={`${label}: ${inertTitle}`}
            />
          }
        >
          <ThreadTagChipContent label={label} />
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-[min(30rem,calc(100vw-2rem))]">
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
          <ContextChip
            kind="mention"
            render={<button type="button" />}
            aria-label={`Open ${shell.title}`}
            className="hover:underline"
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
      <TooltipPopup side="top" className="max-w-[min(30rem,calc(100vw-2rem))]">
        {shell.title}
      </TooltipPopup>
    </Tooltip>
  );
}
