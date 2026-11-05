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
import { cn } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { orderGoalThreadsByHandoff } from "./goalThreadChain";

function resolveChip(thread: EnvironmentThreadShell): { label: string; dot: string } {
  const reason = rowAttentionOf(thread);
  if (reason !== null) {
    return {
      label: attentionLabel(reason),
      dot: reason === "error" ? "bg-destructive" : "bg-warning",
    };
  }
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input")
    return { label: status === "approval" ? "Approval" : "Input", dot: "bg-warning" };
  if (status === "working" || status === "waiting") return { label: "Working", dot: "bg-info" };
  if (status === "failed") return { label: "Failed", dot: "bg-destructive" };
  const workstream = thread.source.workstream;
  if (workstream?.held) return { label: "Staged", dot: "bg-primary" };
  if (workstream?.outcome) return { label: workstream.outcome, dot: "bg-success" };
  return { label: "Ready", dot: "bg-muted-foreground" };
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
        <Badge size="sm" variant="outline">
          {rows.length}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">handoff order</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground/70">No threads under this goal yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map(({ thread: { shell }, isContinuation }) => {
            const chip = resolveChip(shell);
            const isCurrent = shell.id === activeThreadId;
            return (
              <li key={shell.id}>
                <button
                  type="button"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(scopeThreadRef(shell.environmentId, shell.id)),
                    })
                  }
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-md border border-transparent px-2 py-1.5 text-left hover:bg-accent",
                    isContinuation && "ml-2 w-[calc(100%-0.5rem)] border-l-border/70",
                    isCurrent && "border-primary/40 bg-accent/60",
                  )}
                >
                  <span className="truncate text-xs text-foreground/90">{shell.title}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn("size-1.5 shrink-0 rounded-full", chip.dot)} />
                    {chip.label}
                    {isCurrent ? <span className="ml-auto text-primary/80">current</span> : null}
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
