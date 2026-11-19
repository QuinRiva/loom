/**
 * loom: the questions put to code query threads, as marks on the lines they asked about
 * (plans/code-query/plan.mdx §6). One derived atom per environment that keeps its value while the
 * questions are unchanged, so the stamps restamp only when a question is asked or a thread leaves.
 */
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  DOCUMENT_QUERY_ROLE,
  type EnvironmentId,
  type LoomCodeQueryQuestion,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../../state/threads";
import type { LineAuthor } from "./authorship";

export interface CodeQuestion extends Pick<
  LoomCodeQueryQuestion,
  | "askedAt"
  | "commitSha"
  | "ownerShas"
  | "commitChanged"
  | "filePath"
  | "startLine"
  | "endLine"
  | "excerpt"
> {
  readonly queryThreadId: ThreadId;
  readonly authorThreadId: ThreadId;
}

const NO_QUESTIONS: ReadonlyArray<CodeQuestion> = Object.freeze([]);

/** Every question of a live code query thread, oldest first. A superseded one is archived. */
function codeQuestionsOf(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<CodeQuestion> {
  return threads
    .flatMap((thread) => {
      const workstream = thread.workstream;
      return workstream?.role === DOCUMENT_QUERY_ROLE &&
        workstream.codeQuery &&
        workstream.forkFromThreadId &&
        workstream.outcome === null &&
        thread.archivedAt === null &&
        thread.deletedAt === null
        ? workstream.codeQuery.questions.map((question) => ({
            queryThreadId: thread.id,
            authorThreadId: workstream.forkFromThreadId!,
            askedAt: question.askedAt,
            commitSha: question.commitSha,
            ownerShas: question.ownerShas,
            commitChanged: question.commitChanged,
            filePath: question.filePath,
            startLine: question.startLine,
            endLine: question.endLine,
            excerpt: question.excerpt,
          }))
        : [];
    })
    .toSorted((left, right) => left.askedAt.localeCompare(right.askedAt));
}

const withoutNewline = (text: string) => text.replace(/\r?\n$/, "");

/** New-side `line`'s text in `diff`, when the diff holds it. */
export function lineText(diff: FileDiffMetadata, line: number): string | undefined {
  const hunk = diff.isPartial
    ? diff.hunks.find(
        (candidate) =>
          line >= candidate.additionStart &&
          line < candidate.additionStart + candidate.additionCount,
      )
    : undefined;
  const text = diff.isPartial
    ? hunk && diff.additionLines[hunk.additionLineIndex + line - hunk.additionStart]
    : diff.additionLines[line - 1];
  return text === undefined ? undefined : withoutNewline(text);
}

/**
 * Whether `question` marks new-side `line` of `path` (branch owner `owner`, reading `text`). Asked
 * of the lines' writer: while one of those commits owns it. Asked of a thread that changed the
 * file: while it has no branch owner and reads as when asked, since such lines move when lines
 * above them do, and a mark drops rather than land on a neighbour.
 */
export const marks = (
  question: CodeQuestion,
  path: string,
  line: number,
  owner: LineAuthor | null,
  text: string | undefined,
) =>
  question.filePath === path &&
  line >= question.startLine &&
  line <= question.endLine &&
  (question.commitChanged === "file"
    ? owner === null &&
      text !== undefined &&
      // The excerpt is the asked hunk: its header, then one line each with a one-character marker.
      question.excerpt.split("\n")[1 + line - question.startLine]?.slice(1) === withoutNewline(text)
    : owner?.sha != null && question.ownerShas.includes(owner.sha));

const questionsAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous = NO_QUESTIONS;
  return Atom.make((get) => {
    const next = codeQuestionsOf(
      get(environmentThreadShells.environmentThreadsAtom(environmentId)),
    );
    // A question is immutable once asked, so (thread, askedAt) identifies it.
    const same =
      next.length === previous.length &&
      next.every(
        (question, index) =>
          question.queryThreadId === previous[index]!.queryThreadId &&
          question.askedAt === previous[index]!.askedAt,
      );
    if (!same) previous = next.length === 0 ? NO_QUESTIONS : next;
    return previous;
  }).pipe(Atom.withLabel(`loom-code-query-questions:${environmentId}`));
});

const NONE_ATOM = Atom.make(NO_QUESTIONS).pipe(Atom.withLabel("loom-code-query-questions:none"));

export function useCodeQuestions(environmentId: EnvironmentId | null) {
  return useAtomValue(environmentId === null ? NONE_ATOM : questionsAtom(environmentId));
}
