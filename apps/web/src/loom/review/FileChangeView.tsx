/**
 * loom: a changed file shown whole (old left, new right) through the Diff panel's code view with
 * `expandUnchanged`, never a `FileDiff` in the file tab's `Virtualizer` (20 to 25 fps on a fling).
 * Both sides load before the one render, so the page never jumps. Above the size cap it opens from
 * its patch in hunk mode: highlighting both whole files freezes the page (380 ms at 10,000 lines).
 */
import {
  type FileContents,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  parseDiffFromFile,
} from "@pierre/diffs";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Columns2Icon, EyeIcon, FileCode2Icon, PencilIcon, Rows3Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AnnotatableCodeView,
  type AnnotatableCodeViewHandle,
} from "../../components/diffs/AnnotatableCodeView";
import {
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "../../components/files/fileSurfaceChrome";
import { readRememberedScroll, rememberScroll } from "../../components/files/rememberedScroll.loom";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import type { DraftId } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { createGitDiffFileContentsLoader } from "../../lib/diffFileContents";
import {
  buildFileDiffContentVersion,
  getRenderablePatch,
  resolveDiffThemeName,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { isEditableFocused } from "../../lib/editableFocus";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { useAtomCommand } from "../../state/use-atom-command";
import { LoomBaselineChip } from "./BaselineChip";
import { ChangeRuler, LoomChangeCounter } from "./ChangeRuler";
import {
  changeInRows,
  nearestChange,
  rowsOnScreen,
  rulerChanges,
  rulerTotalRows,
  useChangeNavigationStore,
} from "./changeNavigation";
import { useReviewBaselineStore } from "./reviewBaselineStore";
import { createLoomReviewFileContentsLoader, loomReviewQueries } from "./reviewQueries";
import type { LoomChangeMarks, LoomChangedFile } from "./useLoomChangeMarks";

/** About 5,000 lines of ordinary source; either side over this opens in hunk mode. */
export const WHOLE_FILE_MAX_BYTES = 250_000;
export const WHOLE_FILE_MAX_LINES = 5_000;

const CHANGE_TYPE = {
  added: "new",
  deleted: "deleted",
  renamed: "rename-changed",
  modified: "change",
} as const satisfies Record<LoomChangedFile["status"], FileDiffMetadata["type"]>;

/** The loaders only read a file's names and change type. */
function fileDiffStub(
  path: string,
  previousPath: string | null,
  status: LoomChangedFile["status"],
): FileDiffMetadata {
  return {
    name: path,
    ...(previousPath ? { prevName: previousPath } : {}),
    type: CHANGE_TYPE[status],
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    deletionCharacterCount: 0,
    additionCharacterCount: 0,
  };
}

type WholeFileState =
  | { readonly key: string; readonly diff: FileDiffMetadata }
  | { readonly key: string; readonly error: string };

export interface FileChangeViewProps {
  readonly file: LoomChangedFile;
  /** A new revision reloads both sides (the comparison refreshed). */
  readonly revision: string;
  readonly oversize: boolean;
  /** Both sides of the file under the baseline. */
  readonly loadDiffFiles: FileDiffContentsLoader;
  /** The file's own patch, read only while it is over the size cap. */
  readonly patch: { readonly text: string | null; readonly error: string | null };
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  /** Where the reader's place in this file is remembered across a thread switch. */
  readonly scrollKey?: string;
}

export function FileChangeView({
  file,
  revision,
  oversize,
  loadDiffFiles,
  patch,
  composerDraftTarget,
  scrollKey,
}: FileChangeViewProps) {
  const resolvedTheme = useRenderedAppearance(); // the diff worker pool resolves only this theme
  const layout = useReviewBaselineStore((state) => state.fileChangeLayout);
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const { path, previousPath, status } = file;
  const [retry, setRetry] = useState(0);
  const key = `${path}\u0000${revision}\u0000${retry}`;
  // The surface builds a loader per render; the file and revision decide when to read again.
  const load = useStableCallback(loadDiffFiles);
  const [wholeRequestedFor, setWholeRequestedFor] = useState<string | null>(null);
  const mode = oversize && wholeRequestedFor !== file.path ? "patch" : "whole";
  const [whole, setWhole] = useState<WholeFileState | null>(null);

  useEffect(() => {
    if (mode !== "whole") return;
    let cancelled = false;
    void load(fileDiffStub(path, previousPath, status)).then(
      ({ oldFile, newFile }) => {
        if (cancelled) return;
        const side = (contents: FileContents | null) =>
          contents && { ...contents, cacheKey: `loom-file-change:${key}:${contents.cacheKey}` };
        try {
          setWhole({
            key,
            diff: parseDiffFromFile(
              status === "added" ? null : side(oldFile),
              status === "deleted" ? null : side(newFile),
            ),
          });
        } catch {
          // Pierre refuses two identical sides; a whitespace-only change under hidden whitespace.
          setWhole({ key, error: "No line changes in this file under the current comparison." });
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        setWhole({
          key,
          error: error instanceof Error ? error.message : "Could not load this file's changes.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, load, mode, path, previousPath, status]);

  const patchDiff =
    mode === "patch" && patch.text !== null
      ? getRenderablePatch(patch.text, `loom-file-change:${resolvedTheme}`, {
          compactPartialHunkOffsets: true,
        })
      : null;
  // Keep the last whole file of this path on screen while a refreshed comparison reloads.
  const wholeOnScreen = whole && whole.key.startsWith(`${file.path}\u0000`) ? whole : null;
  const fileDiff =
    mode === "patch"
      ? patchDiff?.kind === "files"
        ? patchDiff.files[0]
        : undefined
      : wholeOnScreen && "diff" in wholeOnScreen
        ? wholeOnScreen.diff
        : undefined;

  const [codeView, setCodeView] = useState<AnnotatableCodeViewHandle | null>(null);
  const changes = fileDiff ? rulerChanges(fileDiff, layout) : [];
  const openedRef = useRef<{ readonly key: string; readonly mode: typeof mode } | null>(null);
  useEffect(() => {
    const instance = codeView?.getInstance();
    const root = instance?.getContainerElement();
    if (!codeView || !instance || !root || changes.length === 0) return;
    const owner = {};
    // A jump holds "n" on its change while that change stays in view: one near the end cannot be
    // centred, and the nearest to the centre would then be its neighbour, so next would stick.
    let pinned: number | null = null;
    const jump = (index: number) => {
      const change = changes[index]!;
      pinned = index;
      useChangeNavigationStore.setState({ current: index });
      codeView.scrollTo({
        type: "line",
        id: file.path,
        lineNumber: change.lineNumber,
        side: change.side,
        align: "center",
      });
    };
    const previous = useChangeNavigationStore.getState();
    useChangeNavigationStore.setState({
      owner,
      path: file.path,
      count: changes.length,
      current: previous.path === file.path ? Math.min(previous.current, changes.length - 1) : 0,
      jump,
      step: (delta) =>
        jump(
          (useChangeNavigationStore.getState().current + delta + changes.length) % changes.length,
        ),
    });
    // Open where this thread left the file; else on the first change with the code above it in
    // view, not on line 1 of a long file. A hunk-mode line in a gap the reader had expanded no
    // longer resolves, so its scroll offset goes first as the fallback.
    const opened = openedRef.current;
    const openKey = scrollKey ?? file.path;
    if (opened?.key !== openKey || opened.mode !== mode) {
      openedRef.current = { key: openKey, mode };
      const saved =
        scrollKey && opened?.key !== openKey ? readRememberedScroll(scrollKey) : undefined;
      if (saved) {
        codeView.scrollTo({ type: "position", position: saved.top });
        if (saved.anchor) {
          const { line, side, offset } = saved.anchor;
          codeView.scrollTo({
            type: "line",
            id: file.path,
            lineNumber: line,
            ...(side ? { side } : {}),
            align: "start",
            offset,
          });
        }
      } else if (mode === "whole") jump(0);
      else codeView.scrollTo({ type: "position", position: 0 });
    }
    // The top line once scrolling pauses, not just pixels: a remount re-estimates wrapped line
    // heights above it.
    const remember = (withAnchor: boolean) => {
      if (!scrollKey) return;
      const top = instance.getScrollTop();
      const itemTop = instance.getTopForItem(file.path) ?? 0;
      const anchor = withAnchor
        ? instance
            .getRenderedItems()
            .find((rendered) => rendered.id === file.path)
            ?.instance.getNumericScrollAnchor(top - itemTop)
        : undefined;
      rememberScroll(scrollKey, {
        top,
        anchor: anchor && {
          line: anchor.lineNumber,
          offset: itemTop + anchor.top - top,
          ...(anchor.side ? { side: anchor.side } : {}),
        },
      });
    };
    // Which change is at the centre, read from the rows on screen once scrolling settles.
    const settle = () => {
      remember(true);
      const rows = rowsOnScreen(root, layout);
      if (!rows) return;
      if (pinned !== null && changeInRows(changes[pinned]!, rows.first, rows.last)) return;
      pinned = null;
      useChangeNavigationStore.setState({ current: nearestChange(changes, rows.centre) });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = instance.subscribeToScroll(() => {
      remember(false);
      clearTimeout(timer);
      timer = setTimeout(settle, 150);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
      if (useChangeNavigationStore.getState().owner === owner) {
        useChangeNavigationStore.setState({ owner: null, count: 0 });
      }
    };
  }, [changes, codeView, file.path, layout, mode, scrollKey]);

  const notice =
    mode === "patch" ? (
      <FileSurfaceNotice>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1">
            A large file: showing the changed lines, with the rest one click away in each gap.
          </span>
          <Button size="xs" variant="outline" onClick={() => setWholeRequestedFor(file.path)}>
            Show whole file
          </Button>
        </span>
      </FileSurfaceNotice>
    ) : null;

  if (!fileDiff) {
    const error =
      mode === "patch"
        ? (patch.error ?? (patchDiff?.kind === "raw" ? patchDiff.reason : null))
        : wholeOnScreen && "error" in wholeOnScreen
          ? wholeOnScreen.error
          : null;
    return (
      <>
        {notice}
        {error ? (
          <FileSurfaceFailure
            message={error}
            {...(mode === "whole" ? { onRetry: () => setRetry((count) => count + 1) } : {})}
          />
        ) : mode === "patch" && patch.text !== null ? (
          <FileSurfaceFailure message="No line changes in this file under the current comparison." />
        ) : (
          <FileSurfaceLoading />
        )}
      </>
    );
  }

  return (
    <>
      {notice}
      <div
        className="flex min-h-0 flex-1"
        data-loom-file-change={mode}
        data-loom-keys="[]"
        onKeyDown={(event) => {
          if (
            (event.key !== "[" && event.key !== "]") ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            isEditableFocused(event.target)
          ) {
            return;
          }
          event.preventDefault();
          useChangeNavigationStore.getState().step(event.key === "]" ? 1 : -1);
        }}
      >
        <AnnotatableCodeView
          viewerRef={setCodeView}
          codeViewKey={`${file.path}:${mode}`}
          className="h-full min-h-0 flex-1 overflow-auto"
          files={[
            {
              fileDiff,
              filePath: file.path,
              fileKey: file.path,
              fileVersion: buildFileDiffContentVersion(fileDiff),
              collapsed: false,
            },
          ]}
          pendingFiles={[]}
          sectionId="loom-file-change"
          sectionTitle="Changes"
          composerDraftTarget={composerDraftTarget}
          renderHeaderFilenameSuffix={() => null}
          renderHeaderPrefix={() => null}
          onRevealSearchMatch={() => undefined}
          options={{
            diffStyle: layout,
            disableFileHeader: true,
            expandUnchanged: mode === "whole",
            lineDiffType: "word-alt",
            maxLineDiffLength: 10_000,
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: resolvedTheme,
            ...(mode === "patch" ? { loadDiffFiles } : {}),
          }}
        />
        {/* Hunk mode shows only the changes and their gaps, so its scrollbar is no map of the file. */}
        {mode === "whole" ? (
          <ChangeRuler
            codeView={codeView}
            changes={changes}
            totalRows={rulerTotalRows(fileDiff, layout)}
          />
        ) : null}
      </div>
    </>
  );
}

/** The opened changed file, fed by whichever baseline the Files surface marks against. */
export function LoomFileChangeSurface({
  environmentId,
  threadRef,
  marks,
  file,
  working,
  composerDraftTarget,
  scrollKey,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  marks: LoomChangeMarks;
  file: LoomChangedFile;
  /** The working copy the Files surface already read; its size stands in when git has none. */
  working: { readonly byteLength: number; readonly contents: string } | null;
  composerDraftTarget: ScopedThreadRef | DraftId;
  scrollKey: string;
}) {
  const getLoomContents = useAtomCommand(loomReviewQueries.fileContents);
  const getGitContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const baseline = marks.baseline;
  const workingLines = working?.contents.split("\n").length ?? 0;
  const size = file.bytes ?? working?.byteLength ?? null;
  // A deleted file has no working copy to size; its patch is the whole file anyway.
  const oversize =
    size === null || size > WHOLE_FILE_MAX_BYTES || workingLines > WHOLE_FILE_MAX_LINES;
  const intervalPatch = useEnvironmentQuery(
    oversize && baseline?.kind === "interval"
      ? loomReviewQueries.diff({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            intervalId: baseline.intervalId,
            sourceKinds: baseline.sourceKinds,
            ignoreWhitespace: marks.ignoreWhitespace,
            file: { path: file.path, previousPath: file.previousPath },
          },
        })
      : null,
  );
  const gitPatch = useEnvironmentQuery(
    oversize && baseline?.kind === "git"
      ? reviewEnvironment.diffFilePatch({
          environmentId,
          input: {
            cacheKey: baseline.source.diffHash,
            request: {
              cwd: baseline.cwd,
              ...(baseline.baseRef ? { baseRef: baseline.baseRef } : {}),
              ignoreWhitespace: marks.ignoreWhitespace,
              file: {
                path: file.path,
                previousPath: file.previousPath,
                sourceKind: baseline.source.kind,
              },
            },
          },
        })
      : null,
  );
  if (!baseline) return <FileSurfaceLoading />;
  const loadDiffFiles =
    baseline.kind === "interval"
      ? createLoomReviewFileContentsLoader(getLoomContents, {
          environmentId,
          threadId: threadRef.threadId,
          sources: baseline.sources,
          cacheKey: marks.revision,
        })
      : createGitDiffFileContentsLoader(getGitContents, {
          environmentId,
          cwd: baseline.cwd,
          sourceKind: baseline.source.kind,
          baseRef: baseline.source.baseRef,
          headRef: baseline.source.headRef,
          cacheKey: marks.revision,
        });
  const patchText =
    baseline.kind === "interval"
      ? (intervalPatch.data?.sources.map((source) => source.diff).join("\n") ?? null)
      : (gitPatch.data?.diff ?? null);
  return (
    <FileChangeView
      file={file}
      revision={marks.revision}
      oversize={oversize}
      loadDiffFiles={loadDiffFiles}
      patch={{
        text: patchText,
        error: baseline.kind === "interval" ? intervalPatch.error : gitPatch.error,
      }}
      composerDraftTarget={composerDraftTarget}
      scrollKey={scrollKey}
    />
  );
}

/** The opened file's header: n of m · baseline · split or unified · Edit (or back to the changes). */
export function LoomFileChangeActions({
  threadRef,
  marks,
  editing,
  rendered,
  onEditingChange,
}: {
  threadRef: ScopedThreadRef;
  marks: LoomChangeMarks;
  editing: boolean;
  /** The file renders (markdown, MDX, HTML, a table), so the way back is to the rendering. */
  rendered: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const layout = useReviewBaselineStore((state) => state.fileChangeLayout);
  return (
    <>
      {editing ? null : <LoomChangeCounter />}
      <LoomBaselineChip threadRef={threadRef} marks={marks} />
      {editing ? null : (
        <FileSurfaceAction
          label={layout === "split" ? "Show unified diff" : "Show side by side"}
          onPress={() =>
            useReviewBaselineStore
              .getState()
              .setFileChangeLayout(layout === "split" ? "unified" : "split")
          }
        >
          {layout === "split" ? (
            <Rows3Icon className="size-3.5" />
          ) : (
            <Columns2Icon className="size-3.5" />
          )}
        </FileSurfaceAction>
      )}
      <Button size="xs" variant="outline" onClick={() => onEditingChange(!editing)}>
        {editing ? (
          "Show changes"
        ) : rendered ? (
          <>
            <EyeIcon className="size-3.5" />
            Rendered
          </>
        ) : (
          <>
            <PencilIcon className="size-3.5" />
            Edit
          </>
        )}
      </Button>
    </>
  );
}

/** On each Diff panel file header: the file in the Files surface, whole, under the same baseline. */
export function LoomOpenWholeFileButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Open whole file"
            onClick={onOpen}
          />
        }
      >
        <FileCode2Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Open whole file</TooltipPopup>
    </Tooltip>
  );
}
