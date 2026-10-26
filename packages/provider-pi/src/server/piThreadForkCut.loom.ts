/**
 * A `thread_fork` fork's pi session ends at the call that created it (the assistant message plus
 * its tool results), so the fork keeps its calling turn; upstream's run-boundary cut, pinned to the
 * caller's last completed run, would drop it.
 *
 * @module orchestration-v2/Adapters/piThreadForkCut
 */

const THREAD_FORK_TOOL = "mcp__t3-code__thread_fork";

interface PiSessionEntry {
  readonly type?: string;
  readonly id?: string;
  readonly parentId?: string | null;
  readonly message?: {
    readonly role?: string;
    readonly toolName?: string;
    readonly content?: unknown;
  };
}

/**
 * The session's entry lines from the root to the end of the tool batch whose
 * `thread_fork` result names `forkThreadId`, in order; `undefined` when no such
 * result exists (any other fork keeps upstream's cut). Unparseable lines are
 * skipped, as pi skips them, so a source still being written is safe to read.
 */
export const piThreadForkPath = (
  sessionText: string,
  forkThreadId: string,
): ReadonlyArray<string> | undefined => {
  const entries = sessionText.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as PiSessionEntry;
      return entry.type === "session" ? [] : [{ line, entry }];
    } catch {
      return [];
    }
  });
  let end = entries.findIndex(
    ({ entry: { message } }) =>
      message?.role === "toolResult" &&
      message.toolName === THREAD_FORK_TOOL &&
      JSON.stringify(message.content).includes(forkThreadId),
  );
  if (end === -1) return undefined;
  while (
    entries[end + 1]?.entry.message?.role === "toolResult" &&
    entries[end + 1]!.entry.parentId === entries[end]!.entry.id
  )
    end += 1;
  const byId = new Map(entries.map((entry) => [entry.entry.id, entry]));
  const path: Array<string> = [];
  for (let at = entries[end]; at !== undefined; at = byId.get(at.entry.parentId ?? undefined))
    path.unshift(at.line);
  return path;
};
