/**
 * loom: who wrote each block of the Diff panel's whole-branch diff (plans/diff-author-query/
 * plan.mdx §4). One background request once the diff has loaded, keyed on its content; the
 * answer is stamped onto rows the viewer already drew, so the diff opens and scrolls as before.
 *
 * @module loom/review/useLoomAuthorship
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LoomReviewAuthorshipResult, ScopedThreadRef } from "@t3tools/contracts";
import { useLayoutEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { revisionedQuery } from "../../state/revisionedQuery";
import { authorshipOf } from "./authorship";
import { AUTHORSHIP_CSS, createAuthorshipStamps } from "./authorshipStamps";
import { useReviewBaselineStore } from "./reviewBaselineStore";
import { loomReviewQueries } from "./reviewQueries";

export function useLoomAuthorship({
  threadRef,
  baseRef,
  eligible: inView,
  diffHash,
  complete,
  loaded,
  workspaceMutationId,
}: {
  threadRef: ScopedThreadRef | null;
  /** The base the panel asked its diff for: the user's pick, or null for the automatic one. */
  baseRef: string | null;
  /** The panel shows a view that can have authors. */
  eligible: boolean;
  /** The shown diff's hash; null while it loads. */
  diffHash: string | null;
  /** False for the tracked-files-only listing a refresh shows before the complete one. */
  complete: boolean;
  /** The diff's file list and first patches have arrived. */
  loaded: boolean;
  workspaceMutationId: string | null;
}) {
  const off = useReviewBaselineStore((state) => state.authorshipOff);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const filter = useReviewBaselineStore((state) =>
    threadKey === null ? null : (state.authorFilterByThreadKey[threadKey] ?? null),
  );
  const eligible = threadRef !== null && inView;
  const shown = eligible && !off;
  // The complete listing's hash keys the question; the tracked-only listing's hash is kept to tell
  // whether a refresh's first pass still shows the content an answer was given for.
  const [trackedHash, setTrackedHash] = useState<string | null>(null);
  if (!complete && diffHash !== null && diffHash !== trackedHash) setTrackedHash(diffHash);
  const [asked, setAsked] = useState<{
    readonly hash: string;
    readonly trackedHash: string | null;
  }>();
  if (complete && diffHash !== null && diffHash !== asked?.hash)
    setAsked({ hash: diffHash, trackedHash });
  const hash = asked?.hash ?? null;
  // Latched once the diff's first patches have arrived, so blame never competes with the reads
  // that draw it.
  const [drawn, setDrawn] = useState(false);
  if (!drawn && loaded && hash !== null) setDrawn(true);
  const [stamps] = useState(createAuthorshipStamps);
  // A commit leaves the diff's content as it was, so the workspace revision re-asks too.
  const query = useEnvironmentQuery(
    shown && drawn && hash !== null
      ? revisionedQuery(
          loomReviewQueries.authorship({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, baseRef },
          }),
          `${hash}:${workspaceMutationId ?? ""}`,
        )
      : null,
  );
  // Each answer remembers the content it was asked for, and is drawn only on that content: lines
  // that moved since must never wear the old answer's author while the new one is on its way.
  const [answer, setAnswer] = useState<{
    readonly result: LoomReviewAuthorshipResult;
    readonly at: number;
    readonly asked: typeof asked;
  } | null>(null);
  if (query.data && !query.isPending && query.dataUpdatedAt !== answer?.at)
    setAnswer({ result: query.data, at: query.dataUpdatedAt, asked });
  const current =
    answer !== null &&
    diffHash !== null &&
    (complete ? answer.asked?.hash : answer.asked?.trackedHash) === diffHash;
  const result = shown && current ? answer.result : null;
  const authorship = result === null ? null : authorshipOf(result);
  const activeFilter =
    authorship?.groups.some((group) => group.key === filter) === true ? filter : null;
  // A layout effect, so stale marks are cleared in the commit that draws new rows, before paint.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restamps the viewer's already-rendered rows (DOM outside React) when the answer or filter changes
  useLayoutEffect(() => {
    stamps.update(authorship === null ? null : { authorship, filter: activeFilter });
  }, [stamps, authorship, activeFilter]);

  return {
    /** The toggle shows in a view that can have authors. */
    eligible,
    shown,
    error: shown ? query.error : null,
    authorship,
    /** The reply `authorship` was built from: commit subjects, thread roles and run times. */
    result,
    /** The base the answer was asked against, for the author card's line history. */
    baseRef,
    filter: activeFilter,
    setFilter: (group: string | null) => {
      if (threadRef) useReviewBaselineStore.getState().setAuthorFilter(threadRef, group);
    },
    setOff: (next: boolean) => useReviewBaselineStore.getState().setAuthorshipOff(next),
    /** A file is shown under the filter when the filtered author has a line in it. */
    isFileShown: (path: string) =>
      authorship === null ||
      activeFilter === null ||
      authorship.groups.some((group) => group.key === activeFilter && group.files.has(path)),
    onPostRender: stamps.onPostRender,
    // Always appended: it paints only stamped rows, and a CSS change would re-render the viewer.
    css: AUTHORSHIP_CSS,
  };
}
