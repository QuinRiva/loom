import { forwardRef, type ReactNode } from "react";

import {
  type ChildIndex,
  formatRelativeAge,
  getActivity,
  getAttentionBadges,
  getFanInChip,
  getGateLoopCap,
  getGateWaitLabel,
  getLastActivityAt,
  getRoleIcon,
  getRoleLabel,
  getThreadStatus,
  getVerdictChip,
} from "../lib/workstreamPresentation";
import type { SidebarThreadSummary } from "../types";

/**
 * Quick-facts hover card for a graph node — the cheap glance before committing to
 * a click (open) or the ⓘ (history). Purely presentational; the graph owns the
 * dwell timing and positions this imperatively via the forwarded ref (so pointer
 * tracking never re-renders the SVG). Every field rides on the thread shell
 * already, so this reads live state without any extra fetch.
 */
export const WorkstreamQuickFacts = forwardRef<
  HTMLDivElement,
  {
    readonly thread: SidebarThreadSummary;
    readonly threadById: ChildIndex;
  }
>(function WorkstreamQuickFacts({ thread, threadById }, ref) {
  const status = getThreadStatus(thread, threadById);
  const verdictChip = getVerdictChip(thread);
  const gateWait = getGateWaitLabel(thread, threadById);
  const fanInChip = getFanInChip(thread);
  const badges = getAttentionBadges(thread);
  const hasGate = thread.routes.some((route) => route.kind === "loop");
  const forkedFrom = thread.forkFromThreadId
    ? (threadById.get(thread.forkFromThreadId)?.title ?? thread.forkFromThreadId)
    : null;

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-20 w-[236px] rounded-xl border border-white/20 bg-[#0d1117]/95 p-3 shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur"
    >
      <div className="text-[10px] uppercase tracking-[0.1em] text-white/30">
        {getRoleLabel(thread)}
      </div>
      <div className="mt-0.5 line-clamp-2 text-[13px] font-semibold leading-snug text-white">
        {thread.title}
      </div>

      <dl className="mt-2 flex flex-col gap-1">
        <FactRow label="Status">
          <span style={{ color: status.graphStroke }}>● {status.label}</span>
        </FactRow>
        <FactRow label="Role">
          <span>
            {getRoleIcon(thread)} {getRoleLabel(thread)}
          </span>
        </FactRow>
        <FactRow label="Last activity">
          <span>
            {getActivity(thread, status.column)}
            <span className="ml-1 text-white/35">
              · {formatRelativeAge(getLastActivityAt(thread))}
            </span>
          </span>
        </FactRow>
        {hasGate || thread.gateRounds > 0 ? (
          <FactRow label="Gate rounds">
            <span>
              ⟲ {thread.gateRounds}/{getGateLoopCap(thread)}
            </span>
          </FactRow>
        ) : null}
        {fanInChip ? <FactRow label="Fan-in">{fanInChip.label}</FactRow> : null}
        {forkedFrom ? <FactRow label="Forked from">{forkedFrom}</FactRow> : null}
      </dl>

      {verdictChip || gateWait || badges.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {verdictChip ? (
            <span
              className={`rounded-full border px-2 py-0.5 text-[10.5px] ${verdictChip.borderClass} ${verdictChip.bgClass} ${verdictChip.textClass}`}
            >
              {verdictChip.label}
            </span>
          ) : null}
          {badges.map(({ reason, label }) => (
            <span
              key={reason}
              className="rounded-full border border-orange-400/50 bg-orange-400/10 px-2 py-0.5 text-[10.5px] text-orange-300"
            >
              {label}
            </span>
          ))}
          {gateWait ? (
            <span
              className={`rounded-full border px-2 py-0.5 text-[10.5px] ${
                gateWait.active
                  ? "border-sky-400/40 bg-sky-400/10 text-sky-300"
                  : "border-white/15 bg-white/[0.04] text-white/55"
              }`}
            >
              {gateWait.label}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 text-[11px] text-sky-300/80">click to enter · ⓘ for history</div>
    </div>
  );
});

function FactRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-[11.5px]">
      <dt className="w-[74px] shrink-0 text-white/30">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-white/80">{children}</dd>
    </div>
  );
}
