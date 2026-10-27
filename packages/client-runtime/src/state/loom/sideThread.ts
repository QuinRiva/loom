/**
 * Presentation selectors for side threads (`SIDE_THREAD_ROLES` in contracts): where a side thread
 * shows in a flat list, a sidebar, and the thread tabs. Shared so web and mobile read one rule.
 */
import { sideThreadOf, type OrchestrationV2ThreadShell, type ThreadId } from "@t3tools/contracts";

type Shell = Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "workstream">;

const hasAttention = ({ workstream }: Pick<Shell, "workstream">) =>
  (workstream?.attention.length ?? 0) > 0;

/** Listed in any flat list of threads (palette, mentions): all but an unattended side thread without attention. */
export const isListedThread = (shell: Pick<Shell, "workstream">) => {
  const side = sideThreadOf(shell.workstream);
  return side === null || side.attended || hasAttention(shell);
};

/**
 * Takes a top-level sidebar row: an ordinary thread always; a side thread only when it carries
 * attention (the way a broken one reaches you), or when it is attended and its anchor is not in
 * `hosted` (archived, deleted, or its host row not loaded), so a way in is never lost.
 */
export const isTopLevelRow = (shell: Pick<Shell, "workstream">, hosted: ReadonlySet<ThreadId>) => {
  const side = sideThreadOf(shell.workstream);
  return (
    side === null || hasAttention(shell) || (side.attended && !hosted.has(side.anchorThreadId))
  );
};

/** Nests as a sub-row under its host: an attended side thread that takes no top-level row. */
export const isSubRow = (shell: Pick<Shell, "workstream">, hosted: ReadonlySet<ThreadId>) =>
  sideThreadOf(shell.workstream)?.attended === true && !isTopLevelRow(shell, hosted);

/**
 * The thread a shell hangs from in presentation: its `subagent` parent (the workstream edge),
 * else its side-thread anchor, else null for a root. The one place lineage and the class meet.
 */
const presentationParentOf = (shell: Pick<Shell, "lineage" | "workstream">): ThreadId | null =>
  shell.lineage.relationshipToParent === "subagent"
    ? shell.lineage.parentThreadId
    : (sideThreadOf(shell.workstream)?.anchorThreadId ?? null);

/** The root reached by walking `presentationParentOf` edges (an unloaded ancestor is still named; a cycle stops). */
export const hostRowOf = (
  threadId: ThreadId,
  parents: ReadonlyMap<ThreadId, ThreadId | null>,
): ThreadId => {
  const seen = new Set([threadId]);
  let root = threadId;
  for (let parent = parents.get(root); parent && !seen.has(parent); parent = parents.get(root)) {
    seen.add(parent);
    root = parent;
  }
  return root;
};

/** The parents map `hostRowOf` walks, over the live (unarchived) threads of one list. */
export const presentationParentsOf = (shells: ReadonlyArray<Shell>) =>
  new Map(shells.map((shell) => [shell.id, presentationParentOf(shell)] as const));

/** The live threads whose host row is itself live: the `hosted` set the two row rules take. */
export const hostedThreadIds = (
  parents: ReadonlyMap<ThreadId, ThreadId | null>,
): ReadonlySet<ThreadId> =>
  new Set([...parents.keys()].filter((id) => parents.has(hostRowOf(id, parents))));
