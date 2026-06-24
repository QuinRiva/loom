import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import {
  CheckIcon,
  CircleSlashIcon,
  CloudIcon,
  GitPullRequestIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useMemo } from "react";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useVcsStatus } from "../lib/vcsStatusState";
import type { GraphBreakdown, GraphRollup } from "../lib/workstreamGraph";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { useThreadRunningTerminalIds } from "../terminalSessionState";
import { useUiStateStore } from "../uiStateStore";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import {
  type WorkstreamGraphBadge,
  prStatusIndicator,
  resolveThreadPr,
  resolveWorkstreamGraphBadge,
  terminalStatusFromRunningIds,
} from "./ThreadStatusIndicators.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ChangeRequestStatusIcon({ className }: { className?: string }) {
  return <GitPullRequestIcon className={className} />;
}

// Three pulsing sky dots — the board's LiveDots motif reused as the "active" glyph.
function GraphLiveDots() {
  return (
    <span className="inline-flex items-center gap-[2px]" aria-hidden>
      <span className="size-1 animate-pulse rounded-full bg-current" />
      <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
      <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
    </span>
  );
}

function GraphBadgeGlyph({ tone }: { tone: WorkstreamGraphBadge["tone"] }) {
  switch (tone) {
    case "active":
      return <GraphLiveDots />;
    case "needs":
      return <TriangleAlertIcon className="size-[11px]" />;
    case "dead":
      return <CircleSlashIcon className="size-[11px]" />;
    case "done":
      return <CheckIcon className="size-[12px]" />;
    case "idle":
      return <span className="size-[6px] rounded-full bg-current" aria-hidden />;
  }
}

const BREAKDOWN_LINES: ReadonlyArray<{
  readonly key: keyof GraphBreakdown;
  readonly label: string;
  readonly dotClass: string;
}> = [
  { key: "running", label: "running", dotClass: "bg-sky-400" },
  { key: "awaitingApproval", label: "awaiting approval", dotClass: "bg-amber-400" },
  { key: "inReview", label: "in review", dotClass: "bg-violet-400" },
  { key: "planned", label: "planned", dotClass: "bg-slate-400" },
  { key: "done", label: "done", dotClass: "bg-emerald-400" },
];

/**
 * Trailing badge summarising an orchestrator's whole sub-thread DAG: colour +
 * glyph = rolled-up state, number = state-contextual count. Coexists with the
 * leading own-turn pill and the other trailing icons. Hover expands the count
 * into the per-state breakdown.
 */
export function WorkstreamGraphIndicator({ rollup }: { rollup: GraphRollup }) {
  const badge = resolveWorkstreamGraphBadge(rollup);
  if (!badge) return null;
  const countLabel = badge.count === null ? null : badge.count > 99 ? "99+" : String(badge.count);
  const lines = BREAKDOWN_LINES.filter(({ key }) => rollup.breakdown[key] > 0);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={badge.title}
            className={`inline-flex h-[18px] shrink-0 items-center gap-[5px] rounded-full border px-1.5 text-[11px] font-semibold leading-none tabular-nums ${
              badge.className
            } ${badge.pulse ? "animate-pulse" : ""}`}
          />
        }
      >
        <GraphBadgeGlyph tone={badge.tone} />
        {countLabel === null ? null : <span>{countLabel}</span>}
      </TooltipTrigger>
      <TooltipPopup side="top" className="min-w-44">
        <div className="mb-1 text-xs font-semibold text-foreground">{badge.title}</div>
        {lines.map(({ key, label, dotClass }) => (
          <div className="flex items-center gap-2 py-px text-[11px]" key={key}>
            <span className={`size-[7px] shrink-0 rounded-full ${dotClass}`} />
            <span className="flex-1">{label}</span>
            <span className="tabular-nums text-foreground">{rollup.breakdown[key]}</span>
          </div>
        ))}
        <div className="mt-1.5 border-t border-border/60 pt-1 text-[10.5px] text-muted-foreground">
          {rollup.total} sub-thread{rollup.total === 1 ? "" : "s"} · open row → Workstream panel
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "animate-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useVcsStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  if (!prStatus && !threadStatus) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <ChangeRequestStatusIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[thread.environmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
          </TooltipTrigger>
          <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={threadEnvironmentLabel ?? "Remote"}
                className="inline-flex items-center justify-center"
              />
            }
          >
            <CloudIcon className="size-3 text-muted-foreground/60" />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
