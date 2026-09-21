import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";

import {
  CHAT_FILE_TAG_CHIP_CLASS_NAME,
  FileTagChipContent,
  ThreadTagChipContent,
} from "~/components/chat/FileTagChip";
import { usePathExistence } from "~/components/chat/usePathExistence";
import { isArtifactViewerPath } from "~/components/artifact/artifactView";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useTheme } from "~/hooks/useTheme";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { MarkdownFileLinkMeta } from "~/markdown-links";
import { useRightPanelStore } from "~/rightPanelStore";

/**
 * Loom's file-chip seam over upstream's `fileLinkChip` renderer (slice 1 of the
 * chat-surface re-home). Upstream renders every syntactically resolvable path
 * as a live chip; a chip whose file has since been moved or deleted therefore
 * looks identical to one that works, and clicking it fails somewhere else. Two
 * behaviours are re-attached here, and nothing else — an existing file renders
 * exactly upstream's chip:
 *
 *  - **existence verification** against the shared, batched stat store
 *    (`usePathExistence`): a path the server reports as gone renders a visibly
 *    "missing" chip instead of a dead link. An unverified path (no connected
 *    environment, e.g. the `/preview` harness, or a stat still in flight) keeps
 *    upstream's behaviour, so nothing flickers from live to missing and back.
 *  - **artifact-viewer routing**: an in-workspace `.html` artifact opens the
 *    sandboxed `ArtifactViewPanel` on the web runtime, where there is no
 *    integrated browser to open it in.
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

function ArtifactFileChip(props: {
  meta: MarkdownFileLinkMeta;
  copyMarkdown: string;
  className?: string | undefined;
  threadRef: ScopedThreadRef;
  relativePath: string;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              CHAT_FILE_TAG_CHIP_CLASS_NAME,
              "cursor-pointer transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
              props.className,
            )}
            data-markdown-copy={props.copyMarkdown}
            data-artifact-chip="true"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              useRightPanelStore.getState().openArtifact(props.threadRef, props.relativePath);
            }}
          >
            <FileTagChipContent
              path={props.meta.filePath}
              label={props.meta.basename}
              theme={resolvedTheme}
              selectable
            />
          </button>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight wrap-anywhere"
      >
        {props.meta.targetPath}
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
  threadRef: ScopedThreadRef | undefined;
  metas: Iterable<MarkdownFileLinkMeta>;
  renderChip: FileLinkChipRenderer;
}): FileLinkChipRenderer {
  const { environmentId, threadRef, renderChip } = input;
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
      const relativePath = fileLinkMeta.workspaceRelativePath;
      if (
        threadRef &&
        relativePath !== null &&
        isArtifactViewerPath(fileLinkMeta.filePath) &&
        !isPreviewSupportedInRuntime()
      ) {
        return (
          <ArtifactFileChip
            meta={fileLinkMeta}
            copyMarkdown={copyMarkdown}
            className={className}
            threadRef={threadRef}
            relativePath={relativePath}
          />
        );
      }
      return renderChip(fileLinkMeta, copyMarkdown, className, mediaSource);
    },
    [lookupExistence, renderChip, threadRef],
  );
}

/**
 * Legacy `[Title](thread://<id>)` mentions. This is still the wire form the
 * provider projection emits for a mentioned thread, so transcripts must keep
 * resolving them; it renders as an inert chip, exactly as it did before the
 * re-home.
 */
export const THREAD_LINK_HREF_PREFIX = "thread://";

export function ThreadLinkChip({ label }: { label: string }) {
  return (
    <span className={CHAT_FILE_TAG_CHIP_CLASS_NAME}>
      <ThreadTagChipContent label={label} />
    </span>
  );
}
