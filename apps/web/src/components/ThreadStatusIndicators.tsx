import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { VcsStatusResult } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CloudIcon,
  FolderGit2Icon,
  GitPullRequestIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { buildThreadRouteParams } from "../threadRoutes";
import type { AttentionReason, GraphBreakdown, GraphRollup } from "../lib/workstreamGraph";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { useProject } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { vcsEnvironment } from "../state/vcs";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import {
  ATTENTION_REASON_LABEL,
  resolveWorkstreamGraphBadge,
  type WorkstreamGraphBadge,
} from "./ThreadStatusIndicators.logic";
import type { SidebarThreadSummary } from "../types";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Three pulsing dots — the board's LiveDots motif reused as the "active" glyph.
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

/** Dot colour for a gated sub-thread row in the popover, by its human gate. */
const ACTION_REASON_DOT: Record<AttentionReason, string> = {
  error: "bg-rose-400",
  awaiting_approval: "bg-amber-400",
  awaiting_input: "bg-amber-400",
  awaiting_acceptance: "bg-violet-400",
  needs_guidance: "bg-orange-400",
  proposed_plan: "bg-violet-400",
};

/**
 * Trailing badge summarising an orchestrator's whole sub-thread DAG: colour +
 * glyph = rolled-up state, number = state-contextual count. Coexists with the
 * leading own-turn pill and the other trailing icons.
 *
 * Click opens a popover. In the act-states (attention / deadlocked) it lists the
 * specific sub-threads as buttons that navigate straight to each — the badge is
 * the glance signal, the popover is how you act on it. In watching / settled
 * states it shows the aggregate per-state breakdown instead. Controlled open so
 * the navigating buttons close it explicitly, and the trigger stops propagation
 * so opening it never also fires the orchestrator row's click (which would
 * navigate to the parent).
 */
export function WorkstreamGraphIndicator({ rollup }: { rollup: GraphRollup }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const badge = resolveWorkstreamGraphBadge(rollup);
  if (!badge) return null;
  const countLabel = badge.count === null ? null : badge.count > 99 ? "99+" : String(badge.count);
  const lines = BREAKDOWN_LINES.filter(({ key }) => rollup.breakdown[key] > 0);
  const { actionNodes } = rollup;
  const openThread = (node: (typeof actionNodes)[number]) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(node.environmentId, node.id)),
    });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-thread-selection-safe
        nativeButton={false}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        render={
          <span
            role="button"
            aria-label={badge.title}
            className={`inline-flex h-[18px] shrink-0 cursor-pointer items-center gap-[5px] rounded-full border px-1.5 text-[11px] font-semibold leading-none tabular-nums ${
              badge.className
            } ${badge.pulse ? "animate-pulse" : ""}`}
          />
        }
      >
        <GraphBadgeGlyph tone={badge.tone} />
        {countLabel === null ? null : <span>{countLabel}</span>}
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-60" viewportClassName="px-0 py-0">
        <div className="px-3 pt-2.5 pb-1.5 text-xs font-semibold text-foreground">
          {badge.title}
        </div>
        {actionNodes.length > 0 ? (
          <ul className="max-h-64 overflow-y-auto px-1 pb-1">
            {actionNodes.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  data-thread-selection-safe
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  onClick={(event) => {
                    event.stopPropagation();
                    openThread(node);
                  }}
                >
                  <span
                    className={`size-[7px] shrink-0 rounded-full ${
                      node.reason ? ACTION_REASON_DOT[node.reason] : "bg-rose-400"
                    }`}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[11px] text-foreground">
                      {node.title || "Untitled sub-thread"}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {node.reason ? ATTENTION_REASON_LABEL[node.reason] : "stuck in deadlock"}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-3 pb-1">
            {lines.map(({ key, label, dotClass }) => (
              <div className="flex items-center gap-2 py-px text-[11px]" key={key}>
                <span className={`size-[7px] shrink-0 rounded-full ${dotClass}`} />
                <span className="flex-1">{label}</span>
                <span className="tabular-nums text-foreground">{rollup.breakdown[key]}</span>
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-border/60 px-3 py-1.5 text-[10.5px] text-muted-foreground">
          {actionNodes.length > 0
            ? "Click a sub-thread to open it"
            : `${rollup.total} sub-thread${rollup.total === 1 ? "" : "s"} · open row → Workstream panel`}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);

  if (pr.state === "open") {
    return {
      label: `${presentation.shortName} open`,
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: `${presentation.shortName} closed`,
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} ${presentation.shortName} closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: `${presentation.shortName} merged`,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

export function ChangeRequestStatusIcon({ className }: { className?: string }) {
  return <GitPullRequestIcon className={className} />;
}

export function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: VcsStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const tooltip = thread.branch
    ? `Worktree: ${displayPath} (${thread.branch})`
    : `Worktree: ${displayPath}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/40" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
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
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useEnvironmentQuery(
    thread.branch != null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
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
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread ? (remoteEnvLabel ?? "Remote") : null;
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
