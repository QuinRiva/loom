/**
 * loom: the query pins a document draws — one per question asked about it in a
 * live query thread of its author (plans/plan-query-threads/plan.mdx §5 step 10).
 * A derived atom per (environment, author, file) over the environment's live
 * shells: it recomputes on any shell change but keeps its previous value when
 * the pins are unchanged, so the annotation layer re-renders only when a
 * question is asked or a query thread leaves the live set.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  DOCUMENT_QUERY_ROLE,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type PlanCommentAnchor,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../state/threads";

export interface DocumentQueryPin {
  readonly queryThreadId: ThreadId;
  readonly askedAt: string;
  readonly anchor: PlanCommentAnchor;
  readonly quotedText: string;
}

const NO_PINS: ReadonlyArray<DocumentQueryPin> = Object.freeze([]);

/**
 * Every question of `authorId`'s live query threads on `filePath`, oldest
 * first. Archived, deleted or settled (done/cancelled) query threads draw no
 * pins: a superseded revision's thread is archived with outcome done.
 */
export function documentQueryPinsOf(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  authorId: ThreadId,
  filePath: string,
): ReadonlyArray<DocumentQueryPin> {
  return threads
    .flatMap((thread) => {
      const workstream = thread.workstream;
      return workstream?.role === DOCUMENT_QUERY_ROLE &&
        workstream.forkFromThreadId === authorId &&
        workstream.documentQuery?.filePath === filePath &&
        workstream.outcome === null &&
        thread.archivedAt === null &&
        thread.deletedAt === null
        ? workstream.documentQuery.questions.map(({ askedAt, anchor, quotedText }) => ({
            queryThreadId: thread.id,
            askedAt,
            anchor,
            quotedText,
          }))
        : [];
    })
    .toSorted((left, right) => left.askedAt.localeCompare(right.askedAt));
}

const keyOf = (environmentId: EnvironmentId, authorId: ThreadId, filePath: string) =>
  JSON.stringify([environmentId, authorId, filePath]);

const pinsAtom = Atom.family((key: string) => {
  const [environmentId, authorId, filePath] = JSON.parse(key) as [EnvironmentId, ThreadId, string];
  let previous = NO_PINS;
  return Atom.make((get) => {
    const next = documentQueryPinsOf(
      get(environmentThreadShells.environmentThreadsAtom(environmentId)),
      authorId,
      filePath,
    );
    // A question is immutable once asked, so (thread, askedAt) identifies a pin.
    const same =
      next.length === previous.length &&
      next.every(
        (pin, index) =>
          pin.queryThreadId === previous[index]!.queryThreadId &&
          pin.askedAt === previous[index]!.askedAt,
      );
    if (!same) previous = next.length === 0 ? NO_PINS : next;
    return previous;
  }).pipe(Atom.withLabel(`loom-document-query-pins:${key}`));
});

/**
 * The author a Query from `ref`'s document panel forks: the viewing thread
 * itself, or — when the viewing thread is a query thread — the author it was
 * forked from, so a follow-up lands in the same query thread instead of forking
 * the fork. Null until the thread's shell exists (a draft has no author to fork).
 */
const queryAuthorAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  return Atom.make((get): ThreadId | null => {
    const shell = get(environmentThreadShells.threadShellAtom({ environmentId, threadId }));
    if (shell === null) return null;
    const workstream = shell.source.workstream;
    return workstream?.role === DOCUMENT_QUERY_ROLE && workstream.forkFromThreadId !== null
      ? workstream.forkFromThreadId
      : threadId;
  }).pipe(Atom.withLabel(`loom-document-query-author:${key}`));
});

export function useDocumentQueryAuthor(ref: ScopedThreadRef): ThreadId | null {
  return useAtomValue(queryAuthorAtom(JSON.stringify([ref.environmentId, ref.threadId])));
}

const NO_PINS_ATOM = Atom.make(NO_PINS).pipe(Atom.withLabel("loom-document-query-pins:none"));

export function useDocumentQueryPins(
  environmentId: EnvironmentId,
  authorId: ThreadId | null,
  filePath: string,
): ReadonlyArray<DocumentQueryPin> {
  return useAtomValue(
    authorId === null ? NO_PINS_ATOM : pinsAtom(keyOf(environmentId, authorId, filePath)),
  );
}
