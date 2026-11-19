import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { EditProvider, type CodeViewHandle } from "@pierre/diffs/react";
import { Editor, type EditorFactory } from "@pierre/diffs/edit"; // loom: SPIKE inline diff editing
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useState, type ReactNode, type Ref } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { fnv1a32, resolveFileDiffPath, resolveFileDiffPreviousPath } from "~/lib/diffRendering";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import type { AuthorCardSlot } from "~/loom/review/AuthorCard"; // loom: diff author query
import { nextFileCommentId } from "../files/fileCommentAnnotations";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from "./StyledDiffCodeView";

interface DiffCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  range: SelectedLineRange;
  rangeLabel: string;
  text: string;
}

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup, undefined>;
const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

function annotationSide(range: SelectedLineRange): AnnotationSide {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side = annotationSide(range);
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

interface AnnotatableCodeViewProps {
  environmentId?: EnvironmentId | undefined;
  projectId?: ProjectId | null | undefined;
  codeViewKey: string;
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    fileVersion: number;
    collapsed: boolean;
  }>;
  pendingFiles: ReadonlyArray<FileDiffMetadata>;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: StyledDiffCodeViewOptions<DiffCommentAnnotationGroup>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  className?: string;
  renderCodeViewFooter?: () => ReactNode;
  unsafeCSSExtra?: string;
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderFilenameSuffix: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
  onRevealSearchMatch: (fileKey: string) => void;
  /** loom: diff author query — selecting lines opens the draft as the author card. */
  authorCard?: AuthorCardSlot | undefined;
  /** loom: SPIKE inline diff editing — the new side is editable; each change reports the whole new file. */
  loomEdit?:
    | {
        /** False until the reader clicks into the new side: reading keeps the word highlights. */
        active: boolean;
        onChange: (contents: string) => void;
        /** The session ended (Escape, focus left): the comparison as typed becomes the shown one. */
        onComplete: (fileDiff: FileDiffMetadata) => void;
      }
    | undefined;
}

// loom: SPIKE inline diff editing
const createDiffEditor: EditorFactory<DiffCommentAnnotationGroup, undefined> = (
  editorType,
  options,
  editStateKey,
) => new Editor(editorType, options, editStateKey);

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  environmentId,
  projectId,
  codeViewKey,
  files,
  pendingFiles,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  viewerRef,
  className,
  renderCodeViewFooter,
  unsafeCSSExtra,
  renderHeaderMetadata,
  renderHeaderFilenameSuffix,
  renderHeaderPrefix,
  onRevealSearchMatch,
  authorCard, // loom
  loomEdit, // loom: SPIKE
}: AnnotatableCodeViewProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<{
    fileKey: string;
    filePath: string;
    previousFilePath: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);
  const [draftText, setDraftText] = useState("");
  // loom: diff author query — the review's file and lines, selected again once on mount
  const [restored, setRestored] = useState<AuthorCardSlot["restore"]>(null);
  const [loomCommenting, setLoomCommenting] = useState(false);
  const restore = authorCard?.restore ?? null;
  if (restore !== null && restore !== restored && selectedLines === null && draft === null) {
    const file = files.find((candidate) => candidate.filePath === restore.filePath);
    if (file) {
      setRestored(restore);
      setSelectedLines({ id: file.fileKey, range: restore.range });
    }
  }

  const filesByKey = new Map(files.map((file) => [file.fileKey, file]));
  if (
    draft !== null &&
    !filesByKey.has(draft.fileKey) &&
    // Lazy placeholders have provisional change types, so match both paths instead.
    !pendingFiles.some(
      (file) =>
        resolveFileDiffPath(file) === draft.filePath &&
        resolveFileDiffPreviousPath(file) === draft.previousFilePath,
    )
  ) {
    setDraft(null);
    setDraftText("");
    setSelectedLines(null);
  }
  const items: CodeViewDiffItem<DiffCommentAnnotationGroup>[] = files.map(
    ({ fileDiff, filePath, fileKey, fileVersion, collapsed }) => {
      const persisted = reviewComments
        .filter(
          (comment) =>
            comment.kind === "line" && // loom: MDX-anchor comments carry no line range
            comment.sectionId === sectionId &&
            comment.filePath === filePath &&
            (comment.fenceLanguage ?? "diff") === "diff",
        )
        .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
          const range = restoreDiffReviewCommentRange(fileDiff, comment);
          if (!range) return annotations;
          return appendAnnotationEntry(annotations, range, {
            id: comment.id,
            kind: "comment",
            range,
            rangeLabel: comment.rangeLabel,
            text: comment.text,
          });
        }, []);
      const annotations = draft?.fileKey === fileKey ? [...persisted, draft.annotation] : persisted;
      return {
        id: fileKey,
        type: "diff",
        fileDiff,
        annotations,
        collapsed,
        ...(loomEdit ? { edit: loomEdit.active } : {}), // loom: SPIKE
        version: fnv1a32(
          `${fileVersion}:${collapsed ? "1" : "0"}:${loomEdit?.active ? "e" : ""}:${annotations
            .flatMap((annotation) =>
              annotation.metadata.entries.map(
                (entry) => `${entry.id}:${entry.rangeLabel}:${entry.text}`,
              ),
            )
            .join(":")}`,
        ),
      };
    },
  );

  const removeEntry = (entryId: string) => {
    setSelectedLines(null);
    if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
      setDraft(null);
      setDraftText("");
    } else {
      removeReviewComment(composerDraftTarget, entryId);
    }
  };

  const submitEntry = (entryId: string, text: string) => {
    const entry = draft?.annotation.metadata.entries.find((candidate) => candidate.id === entryId);
    const file = draft ? filesByKey.get(draft.fileKey) : undefined;
    if (!entry || !file) return;
    const comment = buildDiffReviewComment({
      id: entry.id,
      sectionId,
      sectionTitle,
      filePath: file.filePath,
      fileDiff: file.fileDiff,
      range: entry.range,
      text,
    });
    if (comment) addReviewComment(composerDraftTarget, comment);
    setSelectedLines(null);
    setDraft(null);
    setDraftText("");
  };

  const beginComment = (range: SelectedLineRange | null, context: DiffSelectionContext) => {
    if (!range) return;
    const item = context.item;
    if (item.type !== "diff") return;
    const id = nextFileCommentId();
    const filePath = resolveFileDiffPath(item.fileDiff);
    const comment = buildDiffReviewComment({
      id,
      sectionId,
      sectionTitle,
      filePath,
      fileDiff: item.fileDiff,
      range,
      text: "",
    });
    if (!comment) return;
    authorCard?.onFocus({ filePath, range }); // loom: diff author query
    setLoomCommenting(false); // loom
    setDraftText("");
    setDraft({
      fileKey: item.id,
      filePath,
      previousFilePath: resolveFileDiffPreviousPath(item.fileDiff),
      annotation: {
        side: annotationSide(range),
        lineNumber: range.end,
        metadata: {
          entries: [{ id, kind: "draft", range, rangeLabel: comment.rangeLabel, text: "" }],
        },
      },
    });
  };

  // loom: diff author query — the author card heads the draft's annotation; the draft's text box
  // waits for its Comment button.
  const loomCard = (annotation: { readonly metadata: DiffCommentAnnotationGroup }) => {
    const entry = annotation.metadata.entries.find((candidate) => candidate.kind === "draft");
    const file = entry && draft ? filesByKey.get(draft.fileKey) : undefined;
    if (!authorCard || !entry || !file) return null;
    return authorCard.render(
      { filePath: file.filePath, fileDiff: file.fileDiff, range: entry.range },
      {
        commenting: loomCommenting,
        text: draftText, // loom: code query — the card's question is the draft's text
        setText: setDraftText, // loom
        comment: () => setLoomCommenting(true),
        close: () => removeEntry(entry.id),
      },
    );
  };
  const loomShown = (entry: DiffCommentAnnotationEntry) =>
    !authorCard || entry.kind !== "draft" || loomCommenting;

  const view = (
    <StyledDiffCodeView<DiffCommentAnnotationGroup>
      key={codeViewKey}
      {...(loomEdit
        ? {
            onItemEditChange: (event: { file: { contents: string } }) =>
              loomEdit.onChange(event.file.contents),
            onItemEditComplete: ((event: { fileDiff?: FileDiffMetadata }) => {
              if (event.fileDiff) {
                event.fileDiff.cacheKey = `loom-file-change:typed:${Date.now()}`;
                loomEdit.onComplete(event.fileDiff);
              }
              return "accept";
            }) as never,
          }
        : {})}
      {...(viewerRef ? { viewerRef } : {})}
      {...(className ? { className } : {})}
      {...(unsafeCSSExtra ? { unsafeCSSExtra } : {})}
      {...(renderHeaderMetadata
        ? {
            renderHeaderMetadata: (item: CodeViewItem<DiffCommentAnnotationGroup>) =>
              item.type === "diff" ? renderHeaderMetadata(item.fileDiff) : null,
          }
        : {})}
      {...(renderCodeViewFooter ? { renderCodeViewFooter } : {})}
      items={items}
      selectedLines={selectedLines}
      onSelectedLinesChange={setSelectedLines}
      onRevealSearchMatch={(item) => onRevealSearchMatch(item.id)}
      options={{
        ...options,
        enableGutterUtility: draft === null,
        // loom: diff author query — an author card no comment was typed into gives way to a new selection
        enableLineSelection: draft === null || (authorCard !== undefined && draftText === ""),
        onGutterUtilityClick: beginComment,
        ...(authorCard ? { onLineSelectionEnd: beginComment } : {}), // loom
      }}
      renderHeaderFilenameSuffix={(item) =>
        item.type === "diff" ? renderHeaderFilenameSuffix(item.fileDiff) : null
      }
      renderHeaderPrefix={(item) =>
        item.type === "diff"
          ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
          : null
      }
      renderAnnotation={(...[annotation]) => {
        const hasDraft = annotation.metadata.entries.some((entry) => entry.kind === "draft");
        return (
          <div
            className={hasDraft ? "py-1" : "divide-y divide-border/30 border-y border-border/30"}
          >
            {loomCard(annotation) /* loom: diff author query */}
            {annotation.metadata.entries.filter(loomShown).map((entry) => (
              <DiffCommentAnnotation
                key={entry.id}
                environmentId={environmentId}
                projectId={projectId}
                ownerKey={JSON.stringify([
                  environmentId,
                  composerDraftTarget,
                  codeViewKey,
                  entry.id,
                ])}
                kind={entry.kind}
                rangeLabel={entry.rangeLabel}
                text={entry.kind === "draft" ? draftText : entry.text}
                onTextChange={setDraftText}
                onCancel={() => removeEntry(entry.id)}
                onComment={(text) => submitEntry(entry.id, text)}
                onDelete={() => removeEntry(entry.id)}
              />
            ))}
          </div>
        );
      }}
    />
  );
  // loom: SPIKE inline diff editing
  return loomEdit ? <EditProvider createEditor={createDiffEditor}>{view}</EditProvider> : view;
}
