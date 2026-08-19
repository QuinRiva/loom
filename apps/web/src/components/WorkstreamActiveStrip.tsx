import {
  type ChildIndex,
  getActivity,
  getLastActivityAt,
  getRoleLabel,
  getThreadStatus,
  formatRelativeAge,
} from "../lib/workstreamPresentation";
import { formatCostUsd } from "../lib/contextWindow";
import { attentionReasonsOf, hasRunningSignal } from "../lib/workstreamRollup";
import type { SidebarThreadSummary } from "../types";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkstreamModelPill } from "./WorkstreamModelPill";

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
  const preview = thread.lastActivityPreview;
  const running = hasRunningSignal(thread);
  const cost = formatCostUsd(thread.cumulativeCostUsd);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => onOpenThread(thread)}
            className={`flex min-w-[236px] max-w-[274px] items-start gap-2.5 rounded-[10px] border px-2.5 py-2 text-left transition active:translate-y-px ${
              needsHuman
                ? "border-orange-400/45 bg-gradient-to-b from-orange-400/10 to-orange-400/[0.04] hover:from-orange-400/15"
                : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.07]"
            }`}
          />
        }
      >
        {/* Role as a word, not a glyph (workstream-graph-node-redesign §3c):
          the abstract role glyphs were indistinguishable and roles are
          open-ended strings, so a three-letter monogram + tint carries the
          role (two letters made reviewer/researcher both “RE”) and the hover
          title has the rest. */}
        <span
          className="grid size-[26px] shrink-0 place-items-center rounded-lg border font-mono text-[8.5px] font-semibold uppercase"
          style={{
            color,
            borderColor: `${color}80`,
            backgroundColor: `${color}29`,
          }}
        >
          {getRoleLabel(thread).slice(0, 3)}
        </span>
        <span className="min-w-0 flex-1">
          {/* Top row: title + age, right-aligned. */}
          <span className="flex items-baseline gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white">
              {thread.title}
            </span>
            <span className="shrink-0 text-[9.5px] text-white/30">
              {formatRelativeAge(getLastActivityAt(thread))}
            </span>
          </span>
          {/* Turn line: pulse dot + the recent turn action (the "why"). Falls back
            to starting… while running with no preview, and to the short
            getActivity() phrase for a rare attention-flagged, preview-less chip
            so it is never blank. */}
          <span className="mt-1 flex gap-1.5 text-[10.5px] italic leading-snug text-white/50">
            <span
              className="mt-1 size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none"
              style={{ backgroundColor: color }}
            />
            <span className="line-clamp-2 min-w-0">
              {preview ? (
                `› ${preview}`
              ) : running ? (
                <span className="not-italic text-white/30">starting…</span>
              ) : (
                <span className="not-italic text-white/40">
                  {getActivity(thread, status.column)}
                </span>
              )}
            </span>
          </span>
          {/* Meta row: provider pill · cost · tools, omitting any null segment (and
            its separator) — the strip is a glance surface. */}
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[9.5px] text-white/40">
            <WorkstreamModelPill selection={thread.modelSelection} />
            {cost ? (
              <>
                <span className="text-white/20">·</span>
                <span>{cost}</span>
              </>
            ) : null}
            {thread.toolUses !== null ? (
              <>
                <span className="text-white/20">·</span>
                <span>⚒ {thread.toolUses}</span>
              </>
            ) : null}
          </span>
        </span>
      </TooltipTrigger>
      {/* One hover surface for the whole chip: what it opens, plus the full role
          word the three-letter monogram abbreviates. */}
      <TooltipPopup>{`Open ${thread.title} · ${getRoleLabel(thread)}`}</TooltipPopup>
    </Tooltip>
  );
}
