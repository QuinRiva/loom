import type { EnvironmentId, LoomThreadHistoryEntry, ThreadId } from "@t3tools/contracts";
import { ExternalLinkIcon, FileTextIcon, LocateFixedIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  buildTimelineRows,
  type ConversationAnchor,
  describeRoute,
  formatRelativeAge,
  getGateLoopCap,
  getRoleLabel,
  TONE_DOT_CLASSES,
  type WorkstreamNode,
} from "../lib/workstreamPresentation";
import { loomCommands } from "../loom/loomGoalState";
import { LoomContextChip, WorkstreamSpendSlot } from "../loom/WorkstreamSpendSlot";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The inspected thread's event history (`loom.threadHistory`): outcomes with
 * their round's report, flags (yield and resume included), gate routes and
 * plan outcomes, as V1's lifecycle drawer showed. Lives in the panel, not the
 * drawer; fetched when the thread or its sidecar changes (`updatedAt` moves
 * with every Loom event of the thread), and null until that fetch answers (the
 * drawer then shows the sidecar's milestones). Nothing polls.
 */
export function useThreadHistory(
  environmentId: EnvironmentId,
  node: WorkstreamNode | undefined,
): ReadonlyArray<LoomThreadHistoryEntry> | null {
  const load = useAtomCommand(loomCommands.threadHistory, { reportFailure: false });
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly entries: ReadonlyArray<LoomThreadHistoryEntry>;
  } | null>(null);
  const threadId = node?.id;
  const updatedAt = node?.updatedAt ?? null;
  const key = `${threadId}@${updatedAt}`;
  useEffect(() => {
    if (threadId === undefined) return;
    let cancelled = false;
    void load({ environmentId, input: { threadId } }).then((result) => {
      if (!cancelled && result._tag === "Success")
        setLoaded({ key: `${threadId}@${updatedAt}`, entries: result.value.entries });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, threadId, updatedAt, load]);
  return loaded?.key === key ? loaded.entries : null;
}

/**
 * A thread's timeline drawer: the milestones its sidecar records (created,
 * held, dependencies, kickoff), its event history (`buildTimelineRows`) with
 * each outcome's report, and its gate routes. A row that happened in a
 * conversation jumps to it (the spawn row to the parent's dispatch). Reads the
 * shell and updates live. Overlays the panel; Esc or the backdrop dismisses it.
 */
export function WorkstreamTimelineDrawer({
  node,
  history,
  titleOf,
  onClose,
  onOpenThread,
  onOpenReport,
  onJump,
}: {
  readonly node: WorkstreamNode | undefined;
  readonly history: ReadonlyArray<LoomThreadHistoryEntry> | null;
  readonly titleOf: (threadId: ThreadId) => string;
  readonly onClose: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenReport: (reportPath: string) => void;
  readonly onJump: (anchor: ConversationAnchor) => void;
}) {
  const open = node !== undefined;
  const asideRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Modal focus: remember the trigger, focus the close button, keep Tab inside,
  // Esc dismisses, and focus returns to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return onClose();
      if (event.key !== "Tab") return;
      const focusables = asideRef.current?.querySelectorAll<HTMLElement>("button, [href]");
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (restore instanceof HTMLElement) restore.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  const rows = node ? buildTimelineRows(node, titleOf, history) : [];

  return (
    <>
      <div
        aria-hidden
        className={`absolute inset-0 z-20 bg-background/60 transition-opacity duration-200 motion-reduce:transition-none ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
      />
      <aside
        ref={asideRef}
        inert={!open}
        aria-hidden={!open}
        aria-modal={open}
        role="dialog"
        aria-label="Thread timeline"
        className={`absolute inset-y-0 right-0 z-30 flex w-[340px] max-w-[85%] flex-col border-l border-border bg-popover text-popover-foreground shadow-lg transition-transform duration-200 ease-in-out motion-reduce:transition-none ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-foreground">
              {node?.title ?? "—"}
            </div>
            <div className="truncate text-2xs text-muted-foreground">
              {node ? getRoleLabel(node) : "sub-thread"} · timeline
            </div>
            {node ? (
              <div className="flex flex-wrap gap-x-2 font-mono text-2xs text-muted-foreground">
                <WorkstreamSpendSlot threadId={node.id} />
                <LoomContextChip usage={node.contextUsage} />
              </div>
            ) : null}
          </div>
          {node?.reportPath ? (
            <Button size="xs" variant="outline" onClick={() => onOpenReport(node.reportPath!)}>
              <FileTextIcon />
              Report
            </Button>
          ) : null}
          {node ? (
            <Button size="xs" variant="outline" onClick={() => onOpenThread(node.id)}>
              <ExternalLinkIcon />
              Open
            </Button>
          ) : null}
          <Button
            ref={closeRef}
            size="icon-xs"
            variant="ghost"
            aria-label="Close timeline"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <ol className="flex flex-col">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex items-start gap-2 border-l border-border py-1.5 pl-3"
              >
                <span
                  className={`-ml-[17px] mt-1 size-2 shrink-0 rounded-full ${TONE_DOT_CLASSES[row.tone]}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="text-xs font-medium text-foreground">{row.label}</span>
                  {row.detail ? (
                    <span className="ml-1.5 text-2xs text-muted-foreground">{row.detail}</span>
                  ) : null}
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="mt-0.5 shrink-0 font-mono text-3xs tabular-nums text-muted-foreground" />
                    }
                  >
                    {formatRelativeAge(row.at)}
                  </TooltipTrigger>
                  <TooltipPopup>{row.at}</TooltipPopup>
                </Tooltip>
                {row.jump ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Show me where this happened"
                          onClick={() => onJump(row.jump!)}
                        />
                      }
                    >
                      <LocateFixedIcon />
                    </TooltipTrigger>
                    <TooltipPopup>
                      {row.key === "created"
                        ? "Show where it was dispatched"
                        : "Show me where this happened"}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                {row.reportPath ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="outline"
                          aria-label="Open this round's completion report"
                          onClick={() => onOpenReport(row.reportPath!)}
                        />
                      }
                    >
                      <FileTextIcon />
                    </TooltipTrigger>
                    <TooltipPopup>Open this round&rsquo;s completion report</TooltipPopup>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ol>
          {node && node.routes.length > 0 ? (
            <div className="mt-3 border-t border-border pt-2">
              <div className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
                Gate · ⟲ {node.gateRounds}/{getGateLoopCap(node)}
                {node.pendingRework ? " · rework open" : ""}
              </div>
              <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-foreground/80">
                {node.routes.map((route) => (
                  <li key={`${route.kind}:${route.on.join(",")}`}>
                    {describeRoute(route, titleOf)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}
