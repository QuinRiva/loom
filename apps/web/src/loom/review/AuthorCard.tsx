/**
 * loom: the author card (plans/diff-author-query/plan.mdx §5): the draft comment card under a header
 * naming the thread and commit that wrote the selected lines, and any earlier thread. Open thread
 * goes to that thread with this review's diff beside it (§6); Query author is deferred.
 */
import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  LoomReviewAuthorshipCommit,
  LoomReviewAuthorshipThread,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { authorOf } from "@t3tools/shared/reviewAuthorship.loom";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, MessageCircleIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { resolveFileDiffPath } from "../../lib/diffRendering";
import { buildDiffReviewComment } from "../../reviewCommentContext";
import { useEnvironmentQuery } from "../../state/query";
import { revisionedQuery } from "../../state/revisionedQuery";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { AUTHOR_COLOURS, NEUTRAL_AUTHOR_COLOUR, type AuthorGroup } from "./authorship";
import { followReviewToAuthor, type ReviewFocus, useReviewFollowStore } from "./reviewFollowStore";
import { loomReviewQueries } from "./reviewQueries";
import type { useLoomAuthorship } from "./useLoomAuthorship";

/** What `AnnotatableCodeView` needs to draw its draft as the author card. */
export interface AuthorCardSlot {
  /** The review's focus when the panel mounted, once its file is drawn: selected again once. */
  readonly restore: ReviewFocus | null;
  readonly onFocus: (focus: ReviewFocus) => void;
  readonly render: (
    draft: {
      readonly filePath: string;
      readonly fileDiff: FileDiffMetadata;
      readonly range: SelectedLineRange;
    },
    actions: {
      /** The draft's text box is shown. */
      readonly commenting: boolean;
      readonly comment: () => void;
      readonly close: () => void;
    },
  ) => ReactNode;
}

/** New-side numbers of the added lines a selection holds. */
function addedLines(fileDiff: FileDiffMetadata, range: SelectedLineRange): number[] {
  const diff = buildDiffReviewComment({
    id: "",
    sectionId: "",
    sectionTitle: "",
    filePath: "",
    fileDiff,
    range,
    text: "",
  })?.diff;
  if (diff === undefined) return [];
  const [header = "", ...lines] = diff.split("\n");
  let line = Number(/\+(\d+)/.exec(header)?.[1] ?? 0);
  return lines.flatMap((text) => {
    if (text.startsWith("-")) return [];
    const number = line++;
    return text.startsWith("+") ? [number] : [];
  });
}

const colourOf = (group: AuthorGroup | undefined) =>
  group?.slot == null ? NEUTRAL_AUTHOR_COLOUR : AUTHOR_COLOURS[group.slot];

interface AuthorRow {
  readonly key: string;
  readonly group: AuthorGroup | undefined;
  readonly label: string;
  readonly detail: string | null;
  readonly commit: LoomReviewAuthorshipCommit;
  /** The thread Open thread goes to; null when the commit names none this server holds alone. */
  readonly threadId: ThreadId | null;
}

function rowOf(
  commit: LoomReviewAuthorshipCommit,
  threads: ReadonlyArray<LoomReviewAuthorshipThread>,
  groups: ReadonlyArray<AuthorGroup>,
): AuthorRow {
  const author = authorOf(commit, threads);
  if (author.kind === "thread") {
    const { thread } = author;
    const finished = thread.lastRunAt
      ? `finished ${formatRelativeTimeLabel(thread.lastRunAt)}`
      : null;
    return {
      key: commit.sha,
      group: groups.find((group) => group.key === `thread:${thread.threadId}`),
      label: thread.title,
      detail: [thread.role, thread.archived ? "archived" : null, finished]
        .filter(Boolean)
        .join(" · "),
      commit,
      threadId: thread.threadId,
    };
  }
  const titleOf = (id: ThreadId) => threads.find((thread) => thread.threadId === id)?.title ?? id;
  return {
    key: commit.sha,
    group: undefined,
    label: author.kind === "threads" ? author.threadIds.map(titleOf).join(" + ") : author.name,
    detail:
      author.kind === "threads" ? "two threads committed this" : "not written in a Loom thread",
    commit,
    threadId: null,
  };
}

function AuthorCard({
  authors,
  reviewing,
  routed,
  filePath,
  fileDiff,
  range,
  commenting,
  comment,
  close,
  opensFile,
}: {
  authors: ReturnType<typeof useLoomAuthorship>;
  /** The thread whose diff this is. */
  reviewing: ScopedThreadRef;
  /** The thread in the main window. */
  routed: ScopedThreadRef;
  filePath: string;
  fileDiff: FileDiffMetadata;
  range: SelectedLineRange;
  commenting: boolean;
  comment: () => void;
  close: () => void;
  /** Open thread opens this file whole beside the author, not the Diff panel. */
  opensFile: boolean;
}) {
  const navigate = useNavigate();
  const { authorship, result } = authors;
  const lines = addedLines(fileDiff, range);
  const owners = authorship ? lines.map((line) => authorship.at(filePath, line)) : [];
  const shas = [...new Set(owners.flatMap((owner) => (owner?.sha ? [owner.sha] : [])))];
  const current =
    result === null
      ? []
      : shas.flatMap((sha) => {
          const commit = result.commits.find((candidate) => candidate.sha === sha);
          return commit ? [rowOf(commit, result.threads, authorship?.groups ?? [])] : [];
        });
  const uncommitted = owners.some((owner) => owner?.group.kind === "uncommitted");
  const history = useEnvironmentQuery(
    current.length > 0 && lines.length > 0
      ? revisionedQuery(
          loomReviewQueries.lineHistory({
            environmentId: reviewing.environmentId,
            input: {
              threadId: reviewing.threadId,
              baseRef: authors.baseRef,
              path: filePath,
              startLine: Math.min(...lines),
              endLine: Math.max(...lines),
            },
          }),
          // A commit or a discarded edit changes what the lines' history can be.
          `${result?.headSha ?? ""}:${authors.diffHash ?? ""}`,
        )
      : null,
  );
  // Newest first; one row per earlier thread that is not already a current author.
  const currentThreads = new Set(current.map((row) => row.threadId));
  const earlier = (history.data?.commits ?? [])
    .filter((commit) => !shas.includes(commit.sha))
    .map((commit) => rowOf(commit, history.data?.threads ?? [], authorship?.groups ?? []))
    .filter(
      (row, index, rows) =>
        row.threadId !== null &&
        !currentThreads.has(row.threadId) &&
        rows.findIndex((other) => other.threadId === row.threadId) === index,
    );

  const openThread = (row: AuthorRow) => {
    if (row.threadId === null) return;
    const author = scopeThreadRef(reviewing.environmentId, row.threadId);
    followReviewToAuthor({
      reviewing,
      author,
      authoredAt: row.commit.authoredAt,
      ...(opensFile ? { file: filePath } : {}),
    });
    if (scopedThreadKey(author) !== scopedThreadKey(routed))
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(author) });
  };
  const renderRow = (row: AuthorRow) => (
    <div key={row.key} className="flex min-w-0 items-start gap-2">
      <span
        aria-hidden
        className="mt-1 size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colourOf(row.group) }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-foreground">{row.label}</span>
          {row.detail ? <span className="shrink-0 text-muted-foreground">{row.detail}</span> : null}
        </div>
        <div className="truncate text-muted-foreground">
          <span className="font-mono">{row.commit.sha.slice(0, 7)}</span> {row.commit.subject}
        </div>
      </div>
      {row.threadId !== null ? (
        <Button variant="outline" size="xs" onClick={() => openThread(row)}>
          {scopedThreadKey(scopeThreadRef(reviewing.environmentId, row.threadId)) ===
          scopedThreadKey(routed)
            ? "Show its turn"
            : "Open thread"}
          <ArrowUpRightIcon />
        </Button>
      ) : null}
    </div>
  );

  return (
    <div data-loom-author-card="">
      <div className="flex flex-col gap-1.5 px-3 pt-1 pb-1.5 font-sans text-xs">
        {authorship === null ? (
          <p className="text-muted-foreground">Finding who wrote these lines…</p>
        ) : lines.length === 0 ? (
          <p className="text-muted-foreground">Removed lines have no recorded author.</p>
        ) : current.length === 0 ? (
          <p className="text-muted-foreground">
            {uncommitted
              ? "These lines are not committed yet, so they have no author."
              : result?.files.some((file) => file.path === filePath)
                ? "No thread on this branch wrote these lines."
                : "Who wrote this file is not known here."}
          </p>
        ) : (
          <>
            {current.map(renderRow)}
            {uncommitted ? (
              <p className="text-muted-foreground">Some of these lines are not committed yet.</p>
            ) : null}
          </>
        )}
        {earlier.length > 0 ? (
          <>
            <p className="text-muted-foreground">Earlier, these lines were written by</p>
            {earlier.map(renderRow)}
          </>
        ) : null}
        {commenting ? null : (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost-muted" size="xs" onClick={close}>
              <XIcon />
              Close
            </Button>
            <Button variant="outline" size="xs" onClick={comment}>
              <MessageCircleIcon />
              Comment
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The author card, while authors are shown: the slot `AnnotatableCodeView` draws its draft through,
 * and the return to the review's file and lines when a view mounts on a review that recorded them
 * (this thread's own, or the one it follows). The Diff panel passes how to reveal a file in its
 * list; without that the card is in the whole-file view, whose Open thread opens that file.
 */
export function useAuthorCardSlot({
  authors,
  routed,
  reviewing,
  files,
  revealFile,
  revealLines,
}: {
  authors: ReturnType<typeof useLoomAuthorship>;
  routed: ScopedThreadRef | null;
  reviewing: ScopedThreadRef | null;
  files?: ReadonlyArray<{ readonly fileDiff: FileDiffMetadata; readonly fileKey: string }>;
  /** Unfolds, loads and scrolls to a file; false until the diff lists it. */
  revealFile?: (filePath: string) => boolean;
  revealLines?: (fileKey: string, range: SelectedLineRange) => void;
}): AuthorCardSlot | undefined {
  const [focus] = useState(() =>
    reviewing === null
      ? null
      : (useReviewFollowStore.getState().focusByThreadKey[scopedThreadKey(reviewing)] ?? null),
  );
  const loaded =
    focus === null || files === undefined
      ? undefined
      : files.find(
          (file) =>
            resolveFileDiffPath(file.fileDiff) === focus.filePath &&
            !file.fileDiff.cacheKey?.endsWith(":pending"),
        );
  const stage = useRef<"file" | "lines" | "done">("file");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the viewer (outside React) to the review's file, then its lines, as the diff loads
  useEffect(() => {
    if (focus === null || !revealFile || !revealLines || stage.current === "done") return;
    if (stage.current === "file" && revealFile(focus.filePath)) stage.current = "lines";
    if (stage.current === "lines" && loaded) {
      revealLines(loaded.fileKey, focus.range);
      stage.current = "done";
    }
  });
  if (!authors.shown || routed === null || reviewing === null) return undefined;
  return {
    restore: files === undefined || loaded ? focus : null,
    onFocus: (next) => useReviewFollowStore.getState().setFocus(reviewing, next),
    render: (draft, actions) => (
      <AuthorCard
        authors={authors}
        reviewing={reviewing}
        routed={routed}
        opensFile={files === undefined}
        {...draft}
        {...actions}
      />
    ),
  };
}
