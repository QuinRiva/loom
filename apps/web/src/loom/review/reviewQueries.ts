/**
 * loom: the change-review reads and the live interval's refresh signal. A live diff and the interval
 * list refresh on mount, on an explicit refresh, and when any thread sharing the worktree finishes a
 * run (or the thread itself starts one, once its new message is snapshotted); the server coalesces
 * the captures those refreshes ask for.
 */
import type { FileDiffContentsLoader } from "@pierre/diffs";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  LOOM_WS_METHODS,
  type LoomReviewChangeSource,
  type LoomReviewFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { resolveFileDiffPath } from "../../lib/diffRendering";
import { environmentThreadShells } from "../../state/threads";

const millis = (value: DateTime.Utc | null | undefined) =>
  value ? DateTime.toEpochMillis(value) : 0;

/** Changes when a thread sharing this thread's worktree completes a run, or this one starts one. */
const worktreeRunRevisionAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  return Atom.make((get) => {
    const shells = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const thread = shells.find((shell) => shell.id === threadId);
    if (thread === undefined) return 0;
    return shells.reduce(
      (latest, shell) =>
        (
          thread.worktreePath === null
            ? shell.worktreePath === null && shell.projectId === thread.projectId
            : shell.worktreePath === thread.worktreePath
        )
          ? Math.max(latest, millis(shell.latestRunCompletedAt))
          : latest,
      millis(thread.latestRunStartedAt),
    );
  }).pipe(Atom.withLabel(`loom-review-run-revision:${key}`));
});
const runRevision = (environmentId: EnvironmentId, threadId: ThreadId) =>
  worktreeRunRevisionAtom(JSON.stringify([environmentId, threadId]));

export const loomReviewQueries = {
  intervals: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: `environment-data:${LOOM_WS_METHODS.reviewIntervals}`,
    tag: LOOM_WS_METHODS.reviewIntervals,
    staleTimeMs: 0,
    refreshTrigger: ({ environmentId, input }) => runRevision(environmentId, input.threadId),
  }),
  diff: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: `environment-data:${LOOM_WS_METHODS.reviewDiff}`,
    tag: LOOM_WS_METHODS.reviewDiff,
    staleTimeMs: 0,
    refreshTrigger: ({ environmentId, input }) =>
      input.intervalId === "live" ? runRevision(environmentId, input.threadId) : undefined,
  }),
  fileContents: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: `environment-data:${LOOM_WS_METHODS.reviewFileContents}`,
    tag: LOOM_WS_METHODS.reviewFileContents,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
    },
  }),
};

/** Expands a hunk of an interval's diff from the two snapshot commits its source names. */
export function createLoomReviewFileContentsLoader<E>(
  getFileContents: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: LoomReviewFileContentsInput;
  }) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly sources: ReadonlyArray<LoomReviewChangeSource>;
    readonly cacheKey: string;
  },
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const newPath = resolveFileDiffPath(fileDiff);
    const oldPath = fileDiff.prevName
      ? resolveFileDiffPath({ ...fileDiff, name: fileDiff.prevName })
      : newPath;
    const source = target.sources.find((candidate) =>
      candidate.files.some((file) => file.path === newPath),
    );
    if (!source) throw new Error(`${newPath} is not in this interval's changes.`);
    const result = await getFileContents({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        sourceId: source.id,
        fromCommit: source.fromCommit,
        toCommit: source.toCommit,
        changeType: fileDiff.type,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    const newFile = {
      name: newPath,
      contents: result.value.newContents,
      cacheKey: `${target.cacheKey}:new:${newPath}`,
    };
    if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
    return {
      oldFile: {
        name: oldPath,
        contents: result.value.oldContents,
        cacheKey: `${target.cacheKey}:old:${oldPath}`,
      },
      newFile,
    };
  };
}
