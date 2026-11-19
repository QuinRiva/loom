/**
 * loom: the author card (plans/diff-author-query/plan.mdx §5): the draft comment card under a header
 * naming the thread and commit that wrote the selected lines, and any earlier thread. Open thread
 * goes to that thread with this review's diff beside it (§6). Query author asks that thread's
 * read-only fork, which opens the same way (plans/code-query/plan.mdx §6).
 */
import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  LoomReviewAuthorshipCommit,
  LoomReviewAuthorshipThread,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { authorOf } from "@t3tools/shared/reviewAuthorship.loom";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  MessageCircleIcon,
  MessageCircleQuestionIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { DiffCommentAnnotation } from "../../components/diffs/DiffCommentAnnotation";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { refreshArchivedThreadsForEnvironment } from "../../lib/archivedThreadsState";
import { resolveFileDiffPath } from "../../lib/diffRendering";
import { buildDiffReviewComment } from "../../reviewCommentContext";
import { waitForThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { revisionedQuery } from "../../state/revisionedQuery";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { loomCommands } from "../loomGoalState";
import { AUTHOR_COLOURS, NEUTRAL_AUTHOR_COLOUR, type AuthorGroup } from "./authorship";
import { type CodeQuestion, marks } from "./codeQueryMarks";
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
      /** The draft's text, which a question is typed into too, so a stray selection keeps it. */
      readonly text: string;
      readonly setText: (text: string) => void;
      readonly comment: () => void;
      readonly close: () => void;
    },
  ) => ReactNode;
}

interface CardSection {
  readonly id: string;
  readonly title: string;
}

/** New-side numbers of a selection's added and unchanged lines, and whether it removes any. */
function selectionLines(diff: string | undefined) {
  const added: number[] = [];
  const unchanged: number[] = [];
  let removes = false;
  const [header = "", ...lines] = diff?.split("\n") ?? [];
  let line = Number(/\+(\d+)/.exec(header)?.[1] ?? 0);
  for (const text of lines) {
    if (text.startsWith("-")) removes = true;
    else (text.startsWith("+") ? added : unchanged).push(line++);
  }
  return { added, unchanged, removes };
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
  text,
  setText,
  comment,
  close,
  opensFile,
  section,
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
  text: string;
  setText: (text: string) => void;
  comment: () => void;
  close: () => void;
  /** Open thread opens this file whole beside the author, not the Diff panel. */
  opensFile: boolean;
  /** The view the lines are selected in, recorded with a question. */
  section: CardSection;
}) {
  const navigate = useNavigate();
  const codeQuery = useAtomCommand(loomCommands.codeQuery, { reportFailure: false });
  const [asking, setAsking] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { authorship, result } = authors;
  const selected = buildDiffReviewComment({
    id: "",
    sectionId: section.id,
    sectionTitle: section.title,
    filePath,
    fileDiff,
    range,
    text: "",
  });
  const { added: lines, unchanged, removes } = selectionLines(selected?.diff);
  // Lines the comparison left unchanged: who last wrote them, asked only when they are selected.
  const blamed = lines.length === 0 && !removes && unchanged.length > 0;
  const blame = useEnvironmentQuery(
    blamed && authorship !== null
      ? revisionedQuery(
          loomReviewQueries.lineBlame({
            environmentId: reviewing.environmentId,
            input: {
              threadId: reviewing.threadId,
              path: filePath,
              startLine: Math.min(...unchanged),
              endLine: Math.max(...unchanged),
            },
          }),
          `${result?.headSha ?? ""}:${authors.diffHash ?? ""}`,
        )
      : null,
  );
  const writers = (blame.data?.commits ?? []).map((commit) => {
    const row = rowOf(
      commit,
      blame.data?.threads ?? [],
      (authors.branch ?? authorship)?.groups ?? [],
    );
    const date = new Date(commit.authoredAt).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    return {
      row: row.threadId === null ? { ...row, detail: date } : row,
      // The whole-branch answer lists every branch commit that owns a line of the diff.
      onBranch: result?.commits.some((candidate) => candidate.sha === commit.sha) === true,
    };
  });
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

  // The questions whose mark is on one of these lines, under their author's row.
  // A selection of unchanged lines asks about them, owned by whoever wrote them on the branch.
  const { branch } = authors;
  const askLines = lines.length > 0 ? lines : unchanged;
  const askOwners =
    lines.length > 0
      ? shas
      : [...new Set(unchanged.flatMap((line) => branch?.at(filePath, line)?.sha ?? []))];
  const asked =
    branch === null
      ? []
      : authors.questions.filter((question) =>
          askLines.some((line) => marks(question, filePath, line, branch.at(filePath, line))),
        );

  /** The main window goes to `threadId` at `at`, with this file or diff beside it as it is. */
  const follow = async (threadId: ThreadId, at: string, created = false) => {
    const destination = scopeThreadRef(reviewing.environmentId, threadId);
    followReviewToAuthor({
      reviewing,
      author: destination,
      authoredAt: at,
      ...(opensFile ? { file: filePath } : {}),
    });
    if (scopedThreadKey(destination) === scopedThreadKey(routed)) return;
    // A thread just created reads as missing until its shell reaches this client. Any other
    // thread navigates at once: an archived one is never in the live shells, and its route loads it.
    if (created && !(await waitForThreadShell(destination))) {
      toastManager.add({
        type: "info",
        title: "Question sent",
        description: "The query thread will appear in the sidebar shortly.",
      });
      return;
    }
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(destination) });
  };
  const openThread = (row: AuthorRow) => {
    if (row.threadId !== null) void follow(row.threadId, row.commit.authoredAt);
  };
  const ask = async (row: AuthorRow, question: string) => {
    if (selected?.selection === undefined || askLines.length === 0) return;
    setPending(true);
    setError(null);
    const result = await codeQuery({
      environmentId: reviewing.environmentId,
      input: {
        reviewThreadId: reviewing.threadId,
        baseRef: authors.baseRef,
        commitSha: row.commit.sha,
        ownerShas: askOwners,
        filePath,
        startLine: Math.min(...askLines),
        endLine: Math.max(...askLines),
        selection: selected.selection,
        startIndex: selected.startIndex,
        endIndex: selected.endIndex,
        rangeLabel: selected.rangeLabel,
        sectionId: section.id,
        sectionTitle: section.title,
        diff: selected.diff,
        question,
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not ask the author.");
      return;
    }
    setText("");
    setAsking(null);
    // A fresh fork archived the author's stale query thread; the graph reads archived shells
    // from a one-shot snapshot.
    if (result.value.created) refreshArchivedThreadsForEnvironment(reviewing.environmentId);
    await follow(result.value.queryThreadId, result.value.askedAt, result.value.created);
  };

  const renderAsked = (question: CodeQuestion) => (
    <div
      key={`${question.queryThreadId}:${question.askedAt}`}
      className="flex min-w-0 items-center gap-2 text-muted-foreground"
      data-loom-code-question=""
    >
      <span aria-hidden className="w-2 shrink-0 text-center font-bold text-primary">
        ?
      </span>
      <span className="min-w-0 flex-1 truncate">
        Asked here {formatRelativeTimeLabel(question.askedAt)}
      </span>
      <Button
        variant="outline"
        size="xs"
        onClick={() => void follow(question.queryThreadId, question.askedAt)}
      >
        Open answer
        <ArrowUpRightIcon />
      </Button>
    </div>
  );
  const renderRow = (row: AuthorRow, askable = true) => [
    // A narrow card (the whole-file view's split layout) wraps the buttons under the name.
    <div key={row.key} className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
      <span
        aria-hidden
        className="mt-1 size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colourOf(row.group) }}
      />
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="max-w-full shrink-0 truncate font-medium text-foreground">
            {row.label}
          </span>
          {row.detail ? (
            <span className="min-w-0 truncate text-muted-foreground">{row.detail}</span>
          ) : null}
        </div>
        <div className="truncate text-muted-foreground">
          <span className="font-mono">{row.commit.sha.slice(0, 7)}</span> {row.commit.subject}
        </div>
      </div>
      <div className="ms-auto flex shrink-0 gap-1">
        {row.threadId !== null && askable && !commenting ? (
          <Button
            variant={asking === row.key ? "secondary" : "outline"}
            size="xs"
            onClick={() => {
              setError(null);
              setAsking(asking === row.key ? null : row.key);
            }}
          >
            <MessageCircleQuestionIcon />
            Query author
          </Button>
        ) : null}
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
    </div>,
    ...asked.filter((question) => question.authorThreadId === row.threadId).map(renderAsked),
    asking === row.key && !commenting ? (
      <div key={`${row.key}:ask`} className="-mx-3">
        <DiffCommentAnnotation
          environmentId={reviewing.environmentId}
          kind="draft"
          rangeLabel={selected?.rangeLabel ?? ""}
          text={text}
          onTextChange={setText}
          onCancel={() => setAsking(null)}
          onComment={(question) => void ask(row, question)}
          placeholder={`Ask “${row.label}” why these lines are the way they are…`}
          submitLabel="Ask"
          pending={pending}
        />
        {error ? <p className="px-3 text-destructive">{error}</p> : null}
      </div>
    ) : null,
  ];
  const rowThreads = new Set([...current, ...earlier].map((row) => row.threadId));

  return (
    <div data-loom-author-card="">
      <div className="flex flex-col gap-1.5 px-3 pt-1 pb-1.5 font-sans text-xs">
        {authorship === null ? (
          <p className="text-muted-foreground">Finding who wrote these lines…</p>
        ) : lines.length === 0 ? (
          removes ? (
            <p className="text-muted-foreground">Removed lines have no recorded author.</p>
          ) : blame.isPending ? (
            <p className="text-muted-foreground">Finding who wrote these lines…</p>
          ) : writers.length === 0 ? (
            <p className="text-muted-foreground">These lines did not change in this comparison.</p>
          ) : (
            <>
              {/* Only a commit on the branch can be asked: the server asks only of those. */}
              <p className="text-muted-foreground">
                {writers.every((writer) => writer.onBranch)
                  ? "These lines changed on this branch, but not in this comparison."
                  : writers.some((writer) => writer.onBranch)
                    ? "Some of these lines are older than this branch; only the thread that changed them on the branch can be asked."
                    : writers.some((writer) => writer.row.threadId !== null)
                      ? "These lines are older than this branch. Query author is offered only on lines the branch changed."
                      : "These lines are older than this branch and no thread wrote them, so there is no one to ask."}
              </p>
              {writers.map((writer) => renderRow(writer.row, writer.onBranch))}
            </>
          )
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
            {current.map((row) => renderRow(row))}
            {asked.filter((question) => !rowThreads.has(question.authorThreadId)).map(renderAsked)}
            {uncommitted ? (
              <p className="text-muted-foreground">Some of these lines are not committed yet.</p>
            ) : null}
          </>
        )}
        {earlier.length > 0 ? (
          <>
            <p className="text-muted-foreground">Earlier, these lines were written by</p>
            {earlier.map((row) => renderRow(row))}
          </>
        ) : null}
        {commenting || asking !== null ? null : (
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
  section,
  files,
  revealFile,
  revealLines,
}: {
  authors: ReturnType<typeof useLoomAuthorship>;
  section: CardSection;
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
        section={section}
        {...draft}
        {...actions}
      />
    ),
  };
}
