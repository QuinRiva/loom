/**
 * loom: who wrote each block of the Diff panel's whole-branch diff (plans/diff-author-query/
 * plan.mdx §4). One background request once the diff has loaded, keyed on its content; the
 * answer is stamped onto rows the viewer already drew, so the diff opens and scrolls as before.
 *
 * @module loom/review/useLoomAuthorship
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

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
  // Latched once the diff's first patches have arrived, so blame never competes with the reads
  // that draw it; a later refresh keeps the answer on screen while it re-asks.
  const [drawn, setDrawn] = useState(false);
  if (!drawn && loaded && diffHash !== null) setDrawn(true);
  // A refresh passes through a tracked-only listing with no hash; the last one keeps the answer.
  const [hash, setHash] = useState(diffHash);
  if (diffHash !== null && diffHash !== hash) setHash(diffHash);
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
  const authorship = shown && query.data ? authorshipOf(query.data) : null;
  const activeFilter =
    authorship?.groups.some((group) => group.key === filter) === true ? filter : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restamps the viewer's already-rendered rows (DOM outside React) when the answer or filter changes
  useEffect(() => {
    stamps.update(authorship === null ? null : { authorship, filter: activeFilter });
  }, [stamps, authorship, activeFilter]);

  return {
    /** The toggle shows in a view that can have authors. */
    eligible,
    shown,
    error: shown ? query.error : null,
    authorship,
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
