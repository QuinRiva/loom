/**
 * loom: a document's query pins, one per question in a live query thread of its author, keyed
 * on author and file as the server resolves them so every view shares them. A derived atom per
 * (environment, author, file) that keeps its value when the pins are unchanged, so the
 * annotation layer re-renders only when a question is asked or a query thread leaves.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  DOCUMENT_QUERY_ROLE,
  type DocumentQueryAuthorResult,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type PlanCommentAnchor,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentThreadShells } from "../state/threads";
import { loomCommands } from "./loomGoalState";

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
 * The thread a Query on `filePath` from `ref`'s panel forks (`loom.documentQueryAuthor`): the
 * signer, else the viewing thread (a query thread stands for its author). Asked once per open
 * document and cached; null until answered, or while the viewer has no shell (a draft).
 */
const queryAuthorAtom = Atom.family((key: string) => {
  const [environmentId, threadId, filePath] = JSON.parse(key) as [EnvironmentId, ThreadId, string];
  return Atom.make((get): DocumentQueryAuthorResult | null =>
    get(environmentThreadShells.threadShellAtom({ environmentId, threadId })) === null
      ? null
      : Option.getOrNull(
          AsyncResult.value(
            get(
              loomCommands.documentQueryAuthor({
                environmentId,
                input: { sourceThreadId: threadId, filePath },
              }),
            ),
          ),
        ),
  ).pipe(Atom.withLabel(`loom-document-query-author:${key}`));
});

export function useDocumentQueryAuthor(
  ref: ScopedThreadRef,
  filePath: string,
): DocumentQueryAuthorResult | null {
  return useAtomValue(queryAuthorAtom(JSON.stringify([ref.environmentId, ref.threadId, filePath])));
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
