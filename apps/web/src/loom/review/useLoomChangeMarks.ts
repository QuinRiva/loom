/**
 * loom: what the Files surface marks as changed (plans/change-review/plan.mdx §4). The baseline is
 * the one the Diff panel shares: the selected review interval when there is one, else upstream's
 * git comparison (Uncommitted when the panel is on it, the branch otherwise). Marks derive from the
 * same diff queries the Diff panel reads, so they move only when a comparison refreshes, never per
 * streaming tick or file watch.
 *
 * @module loom/review/useLoomChangeMarks
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  LoomReviewChangeSource,
  ReviewDiffPreviewSource,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";
import { useEffect } from "react";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../../diffPanelStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useWorkspaceMutationRefresh } from "../../hooks/useWorkspaceMutationRefresh";
import { getRenderablePatch } from "../../lib/diffRendering";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { REVIEW_SOURCE_KINDS, useReviewBaselineStore } from "./reviewBaselineStore";
import { loomReviewQueries } from "./reviewQueries";
import { useLoomIntervalLabel, useLoomReviewIntervals } from "./useLoomReviewSelection";

export type LoomChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface LoomChangedFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: LoomChangeStatus;
  /** The larger side's size, when the baseline reports one (intervals do; git does not). */
  readonly bytes: number | null;
}

export type LoomChangeBaseline =
  | {
      readonly kind: "interval";
      readonly intervalId: string;
      readonly sourceKinds: ReadonlyArray<LoomReviewChangeSource["kind"]>;
      readonly sources: ReadonlyArray<LoomReviewChangeSource>;
    }
  | {
      readonly kind: "git";
      readonly cwd: string;
      readonly baseRef: string | null;
      readonly source: ReviewDiffPreviewSource;
    };

export interface LoomChangeMarks {
  /** An interval is selected (the Sources toggle applies), or upstream's git comparison. */
  readonly scope: "interval" | "git";
  readonly label: string;
  readonly marksOff: boolean;
  /** The Files tree collapses to marked files (and is only ever on with a comparison loaded). */
  readonly changedOnly: boolean;
  /** Null while the comparison loads or when marks are off. */
  readonly baseline: LoomChangeBaseline | null;
  readonly files: ReadonlyMap<string, LoomChangedFile>;
  /** Changes whenever the comparison does, so an opened file refetches its sides. */
  readonly revision: string;
  readonly ignoreWhitespace: boolean;
  readonly refresh: () => void;
}

const STATUS_BY_CHANGE_TYPE: Record<FileDiffMetadata["type"], LoomChangeStatus> = {
  new: "added",
  deleted: "deleted",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
  change: "modified",
};

function gitChangedFiles(source: ReviewDiffPreviewSource): LoomChangedFile[] {
  // Upstream's file stats carry no status; the patch does, for every file it was not cut short on.
  const patch = getRenderablePatch(source.diff, "loom-change-marks");
  const parsed = new Map(
    (patch?.kind === "files" ? patch.files : []).map((file) => [file.name, file] as const),
  );
  const stats =
    source.files ??
    [...parsed.values()].map((file) => ({ path: file.name, previousPath: file.prevName ?? null }));
  return stats.map((stat) => {
    const type = parsed.get(stat.path)?.type;
    return {
      path: stat.path,
      previousPath: stat.previousPath,
      status: type ? STATUS_BY_CHANGE_TYPE[type] : stat.previousPath ? "renamed" : "modified",
      bytes: null,
    };
  });
}

export function useLoomChangeMarks({
  threadRef,
  cwd,
  workspaceMutationId,
  enabled,
}: {
  threadRef: ScopedThreadRef;
  cwd: string;
  workspaceMutationId: string | null;
  enabled: boolean;
}): LoomChangeMarks | null {
  const threadKey = scopedThreadKey(threadRef);
  const intervalId = useReviewBaselineStore((state) => state.intervalIdByThreadKey[threadKey]);
  const sources = useReviewBaselineStore((state) => state.sources);
  const marksOff = useReviewBaselineStore((state) => state.marksOff);
  const changedOnly = useReviewBaselineStore((state) => state.changedOnly);
  const ignoreWhitespace = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const selection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, threadRef),
  );
  const intervals = useLoomReviewIntervals(enabled ? threadRef : null);
  const hasIntervals = (intervals.data?.intervals.length ?? 0) > 0;
  useEffect(() => {
    if (enabled && intervalId === undefined && hasIntervals)
      useReviewBaselineStore.getState().seedLive(threadRef);
  }, [enabled, threadRef, intervalId, hasIntervals]);

  const interval = intervals.data?.intervals.find((candidate) => candidate.id === intervalId);
  const intervalActive =
    enabled && intervalId != null && (interval !== undefined || intervals.data === null);
  const sourceKinds = REVIEW_SOURCE_KINDS[sources];
  // The same inputs as the Diff panel's, so both surfaces share one cached comparison.
  const intervalDiff = useEnvironmentQuery(
    intervalActive && !marksOff
      ? loomReviewQueries.diff({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, intervalId, sourceKinds, ignoreWhitespace },
        })
      : null,
  );
  const gitKind = selection.kind === "unstaged" ? "working-tree" : "branch-range";
  const baseRef = selection.kind === "branch" ? selection.baseRef : null;
  const gitPreview = useEnvironmentQuery(
    enabled && !intervalActive && !marksOff
      ? reviewEnvironment.diffPreview({
          environmentId: threadRef.environmentId,
          input: { cwd, ...(baseRef ? { baseRef } : {}), ignoreWhitespace },
        })
      : null,
  );
  useWorkspaceMutationRefresh({
    enabled: enabled && !intervalActive && !marksOff,
    mutationId: workspaceMutationId,
    refresh: gitPreview.refresh,
    resourceKey: `loom-change-marks:${threadKey}:${cwd}`,
  });
  const intervalLabel = useLoomIntervalLabel(interval);
  if (!enabled) return null;

  const gitSource = gitPreview.data?.sources.find((source) => source.kind === gitKind);
  // Not a git repository: nothing to compare against, so no marks and no chips.
  if (!intervalActive && gitPreview.data !== null && gitSource === undefined) return null;

  const baseline: LoomChangeBaseline | null = marksOff
    ? null
    : intervalActive
      ? intervalDiff.data
        ? {
            kind: "interval",
            intervalId,
            sourceKinds,
            sources: intervalDiff.data.sources,
          }
        : null
      : gitSource && gitPreview.data
        ? { kind: "git", cwd: gitPreview.data.cwd, baseRef, source: gitSource }
        : null;
  const changed =
    baseline?.kind === "interval"
      ? baseline.sources.flatMap((source) =>
          source.files.map((file): LoomChangedFile => ({
            path: file.path,
            previousPath: file.previousPath,
            status: file.status,
            bytes: Math.max(file.oldBytes ?? 0, file.newBytes ?? 0),
          })),
        )
      : baseline?.kind === "git"
        ? gitChangedFiles(baseline.source)
        : [];
  return {
    scope: intervalActive ? "interval" : "git",
    label: intervalActive
      ? (intervalLabel ?? "Since your message")
      : gitKind === "working-tree"
        ? "Uncommitted"
        : "Changes (branch)",
    marksOff,
    changedOnly: changedOnly && baseline !== null,
    baseline,
    files: new Map(changed.map((file) => [file.path, file] as const)),
    revision:
      baseline?.kind === "interval"
        ? `${baseline.intervalId}:${baseline.sources.map((source) => source.diffHash).join("|")}`
        : baseline?.kind === "git"
          ? `${baseline.source.kind}:${baseline.source.diffHash}`
          : "none",
    ignoreWhitespace,
    refresh: intervalActive ? intervalDiff.refresh : gitPreview.refresh,
  };
}
