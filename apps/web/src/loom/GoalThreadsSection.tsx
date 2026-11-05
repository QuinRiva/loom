/**
 * loom: the goal panel's Threads section: the goal's root threads in serial handoff order, since
 * workstream children belong to the Workstream graph. One chip per row, in precedence order: what a
 * human must act on outranks what a machine is doing, which outranks where the thread rests.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { attentionLabel, rowAttentionOf } from "@t3tools/client-runtime/state/loom/rollup";
import type { EnvironmentId, GoalId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { Badge } from "../components/ui/badge";
import {
  ATTENTION_COLORS,
  COLUMN_LABELS,
  COLUMN_STYLES,
  type StatusShape,
} from "../lib/workstreamPresentation";
import { cn } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { orderGoalThreadsByHandoff } from "./goalThreadChain";
import { StatusDot } from "./StatusDot";

type Chip = { label: string; color: string; shape?: StatusShape };

/** The graph's state palette (`COLUMN_STYLES`, `ATTENTION_COLORS`), so a state reads alike on both. */
function resolveChip(thread: EnvironmentThreadShell): Chip {
  const reason = rowAttentionOf(thread);
  if (reason !== null) return { label: attentionLabel(reason), color: ATTENTION_COLORS[reason] };
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input")
    return {
      label: status === "approval" ? "Approval" : "Input",
      color: ATTENTION_COLORS.needs_guidance,
    };
  if (status === "working" || status === "waiting")
    return { label: "Working", ...COLUMN_STYLES.in_progress };
  if (status === "failed") return { label: "Failed", color: ATTENTION_COLORS.error };
  const workstream = thread.source.workstream;
  if (workstream?.held) return { label: COLUMN_LABELS.held, ...COLUMN_STYLES.held };
  if (workstream?.outcome)
    return {
      label: workstream.outcome,
      ...COLUMN_STYLES[workstream.outcome === "cancelled" ? "cancelled" : "done"],
    };
  return { label: COLUMN_LABELS.ready, ...COLUMN_STYLES.ready };
}

export function GoalThreadsSection({
  goalId,
  environmentId,
  activeThreadId,
  shells,
}: {
  goalId: GoalId;
  environmentId: EnvironmentId;
  activeThreadId: ThreadId | null;
  shells: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const navigate = useNavigate();
  const rows = orderGoalThreadsByHandoff(
    shells
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.archivedAt === null &&
          thread.lineage.parentThreadId === null &&
          thread.source.workstream?.goalId === goalId,
      )
      .map((thread) => ({
        id: thread.id,
        createdAt: thread.createdAt,
        continuesThreadId: thread.source.workstream?.continuesThreadId ?? null,
        shell: thread,
      })),
  );

  return (
    <section className="mt-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-sm font-medium text-foreground">Threads</h3>
        <Badge variant="outline">{rows.length}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">handoff order</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No threads under this goal yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map(({ thread: { shell }, isContinuation }) => {
            const chip = resolveChip(shell);
            const isCurrent = shell.id === activeThreadId;
            return (
              <li
                key={shell.id}
                // A continuation hangs off the thread it continues, on one rule for every nested row.
                className={cn(isContinuation && "ml-3 border-l border-border pl-1")}
              >
                <button
                  type="button"
                  aria-current={isCurrent || undefined}
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(scopeThreadRef(shell.environmentId, shell.id)),
                    })
                  }
                  // The open thread is marked once, by the row tint upstream's sidebar uses.
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                    isCurrent && "bg-accent",
                  )}
                >
                  <span className="truncate text-sm text-foreground">{shell.title}</span>
                  <span
                    className={cn(
                      "flex items-center gap-1.5 text-xs",
                      // Muted text on the current row's tint is under 4.5:1 in light mode.
                      isCurrent ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <StatusDot color={chip.color} shape={chip.shape} />
                    {chip.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
