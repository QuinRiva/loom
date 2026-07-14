import {
  type ChildIndex,
  getActivity,
  getLastActivityAt,
  getRoleIcon,
  getThreadStatus,
  formatRelativeAge,
} from "../lib/workstreamPresentation";
import { attentionReasonsOf, hasRunningSignal } from "../lib/workstreamRollup";
import type { SidebarThreadSummary } from "../types";

/**
 * Active-now strip (step 1–2 of the hierarchy of needs): one chip per in-flight
 * sub-thread — running or human-blocking — so the very first glance answers
 * "what is happening now", and a single click ENTERS the thread (the board's
 * real `openThread` navigation). Attention-flagged threads sort first and take an
 * amber treatment; a subtle pulse marks liveness. Renders nothing when the whole
 * workstream is idle, so it never adds noise to a settled run.
 */
export function WorkstreamActiveStrip({
  threads,
  threadById,
  onOpenThread,
}: {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly threadById: ChildIndex;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
}) {
  const inflight = threads
    .filter((thread) => hasRunningSignal(thread) || attentionReasonsOf(thread).length > 0)
    // Attention-flagged first (needs a human), then the rest; stable by recency.
    .toSorted((left, right) => {
      const leftAttn = attentionReasonsOf(left).length > 0 ? 1 : 0;
      const rightAttn = attentionReasonsOf(right).length > 0 ? 1 : 0;
      if (leftAttn !== rightAttn) return rightAttn - leftAttn;
      return getLastActivityAt(right).localeCompare(getLastActivityAt(left));
    });

  if (inflight.length === 0) return null;

  return (
    <div className="mb-3">
      <div className="mb-2 flex items-center gap-2 px-0.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-white/45">
        <span className="size-1.5 animate-pulse rounded-full bg-sky-400 motion-reduce:animate-none" />
        Active now
      </div>
      <div className="flex flex-wrap gap-2">
        {inflight.map((thread) => (
          <ActiveChip
            key={thread.id}
            thread={thread}
            threadById={threadById}
            onOpenThread={onOpenThread}
          />
        ))}
      </div>
    </div>
  );
}

function ActiveChip({
  thread,
  threadById,
  onOpenThread,
}: {
  readonly thread: SidebarThreadSummary;
  readonly threadById: ChildIndex;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
}) {
  const needsHuman = attentionReasonsOf(thread).length > 0;
  const status = getThreadStatus(thread, threadById);
  const color = needsHuman ? "#fb923c" : status.graphStroke;
  return (
    <button
      type="button"
      onClick={() => onOpenThread(thread)}
      title={`Open ${thread.title}`}
      className={`flex min-w-[200px] max-w-[240px] items-center gap-2.5 rounded-[10px] border px-2.5 py-1.5 text-left transition active:translate-y-px ${
        needsHuman
          ? "border-orange-400/45 bg-gradient-to-b from-orange-400/10 to-orange-400/[0.04] hover:from-orange-400/15"
          : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.07]"
      }`}
    >
      <span
        className="grid size-[26px] shrink-0 place-items-center rounded-lg border text-[13px]"
        style={{
          color,
          borderColor: `${color}80`,
          backgroundColor: `${color}29`,
        }}
      >
        {getRoleIcon(thread)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-white">{thread.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px]" style={{ color }}>
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none"
            style={{ backgroundColor: color }}
          />
          <span className="truncate">
            {getActivity(thread, status.column)}
            <span className="text-white/35"> · {formatRelativeAge(getLastActivityAt(thread))}</span>
          </span>
        </span>
      </span>
    </button>
  );
}
