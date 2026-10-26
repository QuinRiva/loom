/**
 * loom: a promoted query-thread exchange reaches its author as a chip in the author's composer
 * (plans/plan-query-threads/plan.mdx §2.5). The composer draft is client state, so the
 * promotion (an event on the query thread) is seeded into it once per client, never forced: the
 * id is recorded on seed (`workstreamUiStore`, tier 1), so deleting the chip dismisses it for
 * good, and editing or sending it is the human's as with any annotation. Mounted by the
 * author's ChatView.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  DOCUMENT_QUERY_ROLE,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import type { MdxAnchorReviewCommentContext } from "../reviewCommentContext";
import { environmentThreadShells } from "../state/threads";
import { selectSeededPromotionIds, useWorkstreamUiStore } from "./workstreamUiStore";

/**
 * Every promotion on `authorId`'s query threads as the chip it seeds, oldest first. Archived or
 * settled query threads still count: a promotion outlives the review.
 */
export function promotedQueryComments(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  authorId: ThreadId,
): ReadonlyArray<MdxAnchorReviewCommentContext> {
  return threads
    .flatMap((thread) => {
      const workstream = thread.workstream;
      const query = workstream?.documentQuery;
      return workstream?.role === DOCUMENT_QUERY_ROLE &&
        workstream.forkFromThreadId === authorId &&
        thread.deletedAt === null &&
        query
        ? query.promotions.map(({ promotionId, promotedAt, comment }) => ({
            promotedAt,
            chip: {
              kind: "mdx-anchor",
              id: promotionId,
              filePath: query.filePath,
              ...comment,
              queryThreadId: thread.id,
              promotionId,
            } satisfies MdxAnchorReviewCommentContext,
          }))
        : [];
    })
    .toSorted((left, right) => left.promotedAt.localeCompare(right.promotedAt))
    .map(({ chip }) => chip);
}

const NO_CHIPS: ReadonlyArray<MdxAnchorReviewCommentContext> = Object.freeze([]);

/**
 * Adds each promoted chip this client has not seeded yet to the author's composer (appended,
 * never at the caret: the human may be mid-sentence) and records it as seeded.
 */
export function seedPromotedQueryComments(
  authorRef: ScopedThreadRef,
  promoted: ReadonlyArray<MdxAnchorReviewCommentContext>,
) {
  const ui = useWorkstreamUiStore.getState();
  const seeded = new Set(selectSeededPromotionIds(ui, authorRef));
  const fresh = promoted.filter((chip) => !seeded.has(chip.id));
  if (fresh.length === 0) return;
  const { addReviewComment } = useComposerDraftStore.getState();
  for (const chip of fresh) addReviewComment(authorRef, chip, { insertAtCaret: false });
  ui.markPromotionsSeeded(
    authorRef,
    fresh.map((chip) => chip.id),
  );
}

/** The chips `authorId`'s query threads have promoted; a new value only when a promotion lands. */
const promotedChipsAtom = Atom.family((key: string) => {
  const [environmentId, authorId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  let previous = NO_CHIPS;
  return Atom.make((get) => {
    const next = promotedQueryComments(
      get(environmentThreadShells.environmentThreadsAtom(environmentId)),
      authorId,
    );
    // A promotion is immutable once recorded, so its id identifies the chip.
    if (next.length !== previous.length || next.some((chip, i) => chip.id !== previous[i]!.id))
      previous = next.length === 0 ? NO_CHIPS : next;
    return previous;
  }).pipe(Atom.withLabel(`loom-document-query-promotions:${key}`));
});

const NONE_ATOM = Atom.make(NO_CHIPS);

export function useSeedPromotedQueryComments(authorRef: ScopedThreadRef | null) {
  const promoted = useAtomValue(
    authorRef === null
      ? NONE_ATOM
      : promotedChipsAtom(JSON.stringify([authorRef.environmentId, authorRef.threadId])),
  );
  useEffect(() => {
    if (authorRef !== null && promoted.length > 0) seedPromotedQueryComments(authorRef, promoted);
  }, [authorRef, promoted]);
}
