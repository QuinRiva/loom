import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pullRequestDetailToVcsStatus } from "@t3tools/client-runtime/state/pull-requests";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
  type ThreadPullRequestBadge,
} from "@t3tools/shared/threadPullRequests";
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
import { useMemo, useState, type MouseEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { buildThreadRouteParams } from "../threadRoutes";
import type { AttentionReason, GraphBreakdown, GraphRollup } from "../lib/workstreamRollup";
import { Atom } from "effect/unstable/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { buttonVariants, InlineButton } from "./ui/button";
import { cn } from "../lib/utils";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { parseChangeRequestUrl } from "../lib/openPullRequestLink";
import { useEnvironmentQuery } from "../state/query";
import { linkedPullRequestDetailAtom, useSharedPullRequestSummary } from "../state/pullRequests";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useUiStateStore } from "../uiStateStore";
// loom: the Workstream panel is a thread-scoped right-panel surface; the badge
// popover's footer opens it through the same store ChatView's openers use.
import { useRightPanelStore } from "../rightPanelStore";
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
import { pullRequestListLines } from "./pullRequest/pullRequestListLines";
import {
  PULL_REQUEST_STATE_PRESENTATION,
  PullRequestGlyph,
  type PullRequestGlyphIcon,
} from "./pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";

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
 * Trailing badge summarising an orchestrator's whole sub-thread graph: colour +
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
export function WorkstreamGraphIndicator({
  rollup,
  threadRef,
}: {
  rollup: GraphRollup;
  /** The row's own thread — the graph root the footer action opens the panel for. */
  threadRef: ScopedThreadRef;
}) {
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
  // The footer's action: the Workstream panel for THIS root, opened the same
  // way ChatView's own openers do (thread-scoped right-panel store), then
  // navigate so the panel is on screen. Navigating to the already-active
  // thread is a no-op, so no branch is needed.
  const openWorkstreamPanel = () => {
    useRightPanelStore.getState().open(threadRef, "workstream");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
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
        <div className="border-t border-border/60 text-[10.5px] text-muted-foreground">
          {actionNodes.length > 0 ? (
            <div className="px-3 py-1.5">Click a sub-thread to open it</div>
          ) : (
            <button
              type="button"
              data-thread-selection-safe
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-accent hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                openWorkstreamPanel();
              }}
            >
              {/* Count on the right, matching the breakdown rows above — the
                  label has to stay on one line inside the w-60 popover. */}
              <span className="flex-1">Open Workstream panel</span>
              <span className="tabular-nums">{rollup.total}</span>
              <ChevronRightIcon className="size-3 shrink-0" />
            </button>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  Icon: PullRequestGlyphIcon;
  tooltip: string;
  tooltipLead: string;
  tooltipTitle: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export interface LinkedThreadPullRequestStatus {
  readonly pr: NonNullable<ThreadPr>;
  readonly sourceControlProvider: NonNullable<VcsStatusResult["sourceControlProvider"]>;
}

/** Linked badges use persisted snapshots; only branch and legacy fallbacks lease summary reads. */
export function useLinkedThreadPullRequest(
  environmentId: EnvironmentId | null,
  linkedPullRequest: ThreadLinkedPullRequest | null | undefined,
  enabled = true,
  pullRequests?: ReadonlyArray<ThreadPullRequestLink>,
  branchPullRequest?: ThreadLinkedPullRequest | null,
): LinkedThreadPullRequestStatus | null {
  const supportsLinks = useSupportsMultiplePullRequests(environmentId);
  const current = useMemo(
    () => (supportsLinks ? resolveThreadCurrentPullRequestLink(pullRequests ?? []) : null),
    [pullRequests, supportsLinks],
  );
  const fallback =
    current === null ? ((!supportsLinks ? linkedPullRequest : null) ?? branchPullRequest) : null;
  const host = fallback == null ? undefined : parseChangeRequestUrl(fallback.url)?.host;
  const reference =
    fallback == null ? null : { ...fallback, ...(host === undefined ? {} : { host }) };
  const queried = useEnvironmentQuery(
    !enabled || environmentId === null || reference === null
      ? null
      : linkedPullRequestDetailAtom({ environmentId, input: reference }),
  ).data;
  const detail = useSharedPullRequestSummary(environmentId, reference, queried);

  return useMemo(() => {
    if (current !== null) return linkedPullRequestSnapshotStatus(current);
    return detail === null
      ? null
      : {
          pr: pullRequestDetailToVcsStatus(detail),
          sourceControlProvider: { kind: detail.provider, name: detail.provider, baseUrl: "" },
        };
  }, [current, detail]);
}

export function linkedPullRequestSnapshotStatus(
  link: ThreadPullRequestLink,
): LinkedThreadPullRequestStatus | null {
  const snapshot = link.snapshot;
  if (snapshot === null) return null;
  const kind = link.url.includes("/-/merge_requests/")
    ? "gitlab"
    : link.url.includes("/pullrequest/")
      ? "azure-devops"
      : link.url.includes("/pull-requests/")
        ? "bitbucket"
        : link.url.includes("/pulls/")
          ? "forgejo"
          : "github";
  return {
    pr: {
      number: link.number,
      url: link.url,
      title: snapshot.title,
      state: snapshot.state,
      isDraft: snapshot.isDraft,
      headRef: snapshot.headBranch,
      baseRef: snapshot.baseBranch,
      ...(snapshot.updatedAt === null ? {} : { updatedAt: snapshot.updatedAt }),
    },
    sourceControlProvider: { kind, name: kind, baseUrl: "" },
  };
}

export {
  resolveThreadPullRequestBadge,
  type ThreadPullRequestBadge,
} from "@t3tools/shared/threadPullRequests";

export interface ThreadPullRequestBadgePresentation {
  readonly Icon: PullRequestGlyphIcon;
  readonly toneClassName: string;
  readonly label: string;
  readonly text: string | number;
}

/** Resolve the complete badge appearance before rendering it in the sidebar or composer. */
export function resolveThreadPullRequestBadgePresentation({
  badge,
  number,
  url,
  status,
}: {
  readonly badge: ThreadPullRequestBadge | null;
  readonly number?: number | undefined;
  readonly url?: string | undefined;
  readonly status: PrStatusIndicator | null;
}): ThreadPullRequestBadgePresentation | null {
  // The badge already folds every visible link into one state, draft included, so both the
  // stack and the linked count index the shared table directly rather than the single-PR resolver.
  if (badge?.kind === "stack") {
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: PullRequestGlyph.stack,
      toneClassName: aggregate.toneClassName,
      label: `Stack of ${badge.layers} pull requests, ${aggregate.label.toLowerCase()}`,
      text: badge.layers,
    };
  }
  if (number === undefined || url === undefined) return null;

  const tooltip = status?.tooltip ?? `PR #${number}, status pending`;
  if (badge?.kind === "pull-request" && badge.others > 0) {
    // Unrelated links fold into one state, so a count of merged PRs reads as merged.
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: aggregate.Icon,
      toneClassName: aggregate.toneClassName,
      label: `${tooltip}, and ${badge.others} more linked; overall ${aggregate.label.toLowerCase()}`,
      text: `+${badge.others + 1}`,
    };
  }
  return {
    Icon: status?.Icon ?? PullRequestGlyph.pullRequest,
    toneClassName: status?.colorClass ?? "text-muted-foreground",
    label: tooltip,
    text: number,
  };
}

/** The complete linked-PR control shared by the sidebar and composer footer. */
export function ThreadPullRequestBadgeControl({
  variant,
  badge,
  number,
  url,
  status,
  onOpenStack,
  onOpenPullRequest,
}: {
  variant: "underline" | "ghost";
  badge: ThreadPullRequestBadge | null;
  number?: number | undefined;
  url?: string | undefined;
  status: PrStatusIndicator | null;
  onOpenStack: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const presentation = resolveThreadPullRequestBadgePresentation({ badge, number, url, status });
  if (presentation === null) return null;
  const isStack = badge?.kind === "stack";
  const className = cn(
    variant === "ghost"
      ? buttonVariants({ variant: "ghost", size: "xs" })
      : "inline-flex shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap border-b border-transparent hover:border-current focus-visible:outline-2 focus-visible:outline-ring",
    "text-xs tabular-nums",
    variant === "ghost" &&
      "font-normal text-xs! active:scale-100 [--control-icon-color:currentColor]",
    presentation.toneClassName,
  );
  const content = (
    <>
      <presentation.Icon aria-hidden className="size-3 shrink-0" />
      {presentation.text}
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          isStack ? (
            <InlineButton
              className={className}
              aria-label={presentation.label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenStack();
              }}
            />
          ) : (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={className}
              aria-label={presentation.label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onOpenPullRequest}
            />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup side="top">{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A miniature of the pull-requests panel for the thread tooltip: same order, same indentation,
 * so the hover answers "what is in here" without opening the surface.
 */
export function ThreadPullRequestsMiniList({
  pullRequests,
}: {
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}) {
  const lines = useMemo(
    () =>
      pullRequestListLines(resolveThreadPullRequestChains(visibleThreadPullRequests(pullRequests))),
    [pullRequests],
  );
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((line) => {
        const snapshot = line.link.snapshot;
        const presentation =
          snapshot === null
            ? null
            : resolvePullRequestState({ state: snapshot.state, isDraft: snapshot.isDraft });
        return (
          <li
            key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
            className="flex min-w-0 items-center gap-2"
            // Capped like the panel: past a few layers the indent only repeats "still in the
            // stack", and sixteen of them would walk the titles off the popover.
            style={{ paddingLeft: `${Math.min(line.depth, 3) * 0.75}rem` }}
          >
            {presentation ? (
              <presentation.Icon
                aria-hidden
                className={cn("size-3 shrink-0", presentation.toneClassName)}
              />
            ) : (
              <PullRequestGlyph.pullRequest
                aria-hidden
                className="size-3 shrink-0 stroke-muted-foreground"
              />
            )}
            <span className="shrink-0 font-mono tabular-nums">#{line.link.number}</span>
            <span className="min-w-0 truncate text-foreground/75">
              {snapshot?.title ?? line.link.repository}
            </span>
            {line.stack ? (
              <span className="ml-auto shrink-0 pl-1 text-[10px]">
                {line.stack.kind === "native" ? "stack" : "chain"} · {line.stack.size}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);
  const state = resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft === true });

  const tooltipLead = `${presentation.shortName} #${pr.number} - ${state.label}`;
  return {
    label: `${presentation.shortName} ${state.label.toLowerCase()}`,
    colorClass: state.toneClassName,
    Icon: state.Icon,
    tooltip: `${tooltipLead}: ${pr.title}`,
    tooltipLead,
    tooltipTitle: pr.title,
    url: pr.url,
  };
}

export function ChangeRequestStatusIcon({
  state,
  isDraft = false,
  className,
}: Pick<NonNullable<ThreadPr>, "state"> & {
  readonly isDraft?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const presentation = resolvePullRequestState({ state, isDraft });
  return <presentation.Icon className={className} />;
}

export function PrStatusTooltipContent({ status }: { status: PrStatusIndicator }) {
  return (
    <span className="flex max-w-[min(34rem,calc(100vw-2rem))] items-stretch overflow-hidden whitespace-nowrap">
      <span className="shrink-0 pr-2 font-medium">{status.tooltipLead}</span>
      <span className="min-h-4 shrink-0 border-border/70 border-l" aria-hidden="true" />
      <span className="min-w-0 truncate pl-2">{status.tooltipTitle}</span>
    </span>
  );
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
              status.pulse ? "animate-status-pulse" : ""
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
            status.pulse ? "animate-status-pulse" : ""
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
  const pullRequest = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    true,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const pr = pullRequest?.pr ?? null;
  const prStatus = prStatusIndicator(pr, pullRequest?.sourceControlProvider);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const pendingLink =
    pr === null && supportsMultiplePullRequests
      ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
      : null;
  if (!prStatus && !threadStatus && !pendingLink) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus && pr ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <ChangeRequestStatusIcon state={pr.state} isDraft={pr.isDraft} className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <PrStatusTooltipContent status={prStatus} />
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {pendingLink ? (
        <PullRequestGlyph.pullRequest
          className="size-3 text-muted-foreground"
          aria-label={`PR #${pendingLink.number}, status pending`}
        />
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
  // No primary (the hosted app) means every thread is remote, and the machine
  // glyph is what tells the environments apart.
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread ? (remoteEnvLabel ?? "Remote") : null;
  const remoteMachine = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
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
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "animate-status-pulse" : ""}`}
            />
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
            <EnvironmentMachineIcon
              kind={remoteMachine}
              className="size-3 text-muted-foreground/60"
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
