/**
 * loom: the Diff panel's data while a review interval is selected (plans/change-review/plan.mdx
 * §5). The interval's sources come back as one `ReviewDiffPreviewSource`, so upstream's patch
 * pipeline renders it unchanged; hunks expand through loom's file-contents loader.
 *
 * @module loom/review/useLoomReviewSelection
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  LoomReviewInterval,
  ReviewDiffPreviewResult,
  ReviewDiffPreviewSource,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatShortTimestamp } from "../../timestampFormat";
import { REVIEW_SOURCE_KINDS, useReviewBaselineStore } from "./reviewBaselineStore";
import { createLoomReviewFileContentsLoader, loomReviewQueries } from "./reviewQueries";

export function useLoomReviewIntervals(threadRef: ScopedThreadRef | null) {
  return useEnvironmentQuery(
    threadRef
      ? loomReviewQueries.intervals({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
}

/** "Since your message · 14:02", or "Earlier · 13:41 · Pele" for a closed interval. */
function useLoomIntervalLabel(interval: LoomReviewInterval | undefined): string | null {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (!interval) return null;
  const at = formatShortTimestamp(interval.from.at, timestampFormat);
  return interval.to === null
    ? `Since your message · ${at}`
    : ["Earlier", at, interval.from.sender].filter(Boolean).join(" · ");
}

export function useLoomReviewSelection({
  threadRef,
  cwd,
  ignoreWhitespace,
  enabled,
}: {
  threadRef: ScopedThreadRef | null;
  cwd: string | null;
  ignoreWhitespace: boolean;
  enabled: boolean;
}) {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const intervalId = useReviewBaselineStore((state) =>
    threadKey === null ? null : state.intervalIdByThreadKey[threadKey],
  );
  const sources = useReviewBaselineStore((state) => state.sources);
  const intervals = useLoomReviewIntervals(enabled ? threadRef : null);
  const hasIntervals = (intervals.data?.intervals.length ?? 0) > 0;
  useEffect(() => {
    if (threadRef && intervalId === undefined && hasIntervals)
      useReviewBaselineStore.getState().seedLive(threadRef);
  }, [threadRef, intervalId, hasIntervals]);

  const interval = intervals.data?.intervals.find((candidate) => candidate.id === intervalId);
  // An interval capped away falls back to upstream's scope; the live one can load before the list.
  const active =
    enabled && intervalId != null && (interval !== undefined || intervals.data === null);
  const diff = useEnvironmentQuery(
    active && threadRef
      ? loomReviewQueries.diff({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            intervalId,
            sourceKinds: REVIEW_SOURCE_KINDS[sources],
            ignoreWhitespace,
          },
        })
      : null,
  );
  const getFileContents = useAtomCommand(loomReviewQueries.fileContents);
  const label = useLoomIntervalLabel(interval);
  if (!active || !threadRef || cwd === null) return null;

  const changes = diff.data?.sources ?? [];
  const truncated = changes.some((change) => change.truncated);
  const source: ReviewDiffPreviewSource | undefined = diff.data
    ? {
        id: `loom-review:${intervalId}`,
        kind: "branch-range",
        title: label ?? "Since your message",
        baseRef: null,
        headRef: null,
        diff: changes
          .map((change) => change.diff)
          .filter((patch) => patch !== "")
          .map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`))
          .join(""),
        diffHash: changes.map((change) => change.diffHash).join("|") || `${intervalId}:empty`,
        truncated,
        // Without file stats a truncated patch stays on the plain path: the lazy per-file path
        // asks upstream's branch preview, which knows nothing of snapshots.
        ...(truncated ? {} : { files: changes.flatMap((change) => change.files) }),
      }
    : undefined;
  const query: EnvironmentQueryView<ReviewDiffPreviewResult> = {
    ...diff,
    data: diff.data
      ? {
          cwd,
          generatedAt: diff.data.generatedAt,
          sources: source ? [source] : [],
        }
      : null,
    failure: null,
  };
  return {
    label: label ?? "Since your message",
    query,
    source,
    loadDiffFiles: diff.data
      ? createLoomReviewFileContentsLoader(getFileContents, {
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          sources: changes,
          cacheKey: source?.diffHash ?? intervalId,
        })
      : undefined,
  };
}
