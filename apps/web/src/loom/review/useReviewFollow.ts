/**
 * loom: the thread a Diff panel reads its state from: the routed thread, or the review it follows
 * (plans/diff-author-query/plan.mdx §6). See reviewFollowStore.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellStatus } from "../../state/shell";
import { threadFamilies } from "../../state/threads";
import { isThreadRouteSnapshotAuthoritative } from "../../threadRoutes";
import { useAwaitingShelllessThread } from "../useAwaitingShelllessThread";
import { useLoomThreadFamily } from "../useLoomThreadFamily";
import { resolveReviewFollow, useReviewFollowStore } from "./reviewFollowStore";

const NO_FAMILY_ATOM = Atom.make(AsyncResult.initial(true)).pipe(
  Atom.withLabel("loom-review-follow:no-family"),
);

export function useReviewFollow(routed: ScopedThreadRef | null) {
  const reviewing = useReviewFollowStore((state) =>
    routed === null ? null : (state.followByThreadKey[scopedThreadKey(routed)] ?? null),
  );
  const shell = useQuietThreadShell(reviewing);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(
    useEnvironmentShellStatus(reviewing?.environmentId ?? null),
  );
  // Kept mounted while following, so a reviewing root cut from the snapshot stays in the shells.
  useLoomThreadFamily(reviewing?.environmentId ?? null, reviewing?.threadId ?? null);
  const family = threadFamilyRead(
    useAtomValue(
      reviewing === null
        ? NO_FAMILY_ATOM
        : threadFamilies.familyAtom(reviewing.environmentId, reviewing.threadId),
    ),
  );
  // An archived reviewing thread is out of its family; its own shell is fetched.
  const awaitingShell = useAwaitingShelllessThread(reviewing, {
    shellExists: shell !== null,
    bootstrapComplete,
  });
  if (routed === null) return { threadRef: null, reviewing: null };
  const resolved = resolveReviewFollow({
    routed,
    reviewing,
    shell: shell === null ? "absent" : shell.deletedAt != null ? "deleted" : "present",
    family,
    shellless: awaitingShell || !bootstrapComplete ? "pending" : "missing",
  });
  return {
    threadRef: resolved.threadRef,
    /** The review this thread's panel follows, with its title once its shell is here. */
    reviewing: resolved.following ? { ref: resolved.threadRef, title: shell?.title ?? null } : null,
  };
}

/**
 * Whose right-panel width a thread shows: while it follows a review, the review's, so the panel
 * Carl sized there keeps its size and a resize made while following belongs to the review.
 */
export function useReviewPanelKey(routed: ScopedThreadRef | null): string | null {
  const { threadRef } = useReviewFollow(routed);
  return threadRef === null ? null : scopedThreadKey(threadRef);
}
