/**
 * loom: the goal panel's Threads section (3d-3) — the goal's ROOT threads in
 * serial handoff order (`workstream.continuesThreadId`). Workstream children
 * belong to the workstream board, not here.
 *
 * One chip per row, in precedence order: what a human must act on outranks
 * what a machine is doing, which outranks where the thread rests.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { attentionReasonsOf } from "@t3tools/client-runtime/state/loom/rollup";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, GoalId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { cn } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { orderGoalThreadsByHandoff } from "./goalThreadChain";
import { attentionLabel } from "./loomAttention";

function resolveChip(thread: EnvironmentThreadShell): { label: string; dot: string } {
  const reason = attentionReasonsOf(thread.source)[0];
  if (reason !== undefined) {
    return { label: attentionLabel(reason), dot: reason === "error" ? "bg-red-400" : "bg-amber-400" };
  }
  const status = resolveSidebarThreadStatus(thread);
  if (status === "working" || status === "waiting") return { label: "working", dot: "bg-blue-400" };
  if (status === "failed") return { label: "failed", dot: "bg-red-400" };
  const workstream = thread.source.workstream;
  if (workstream?.held) return { label: "staged", dot: "bg-violet-400" };
  if (workstream?.outcome) return { label: workstream.outcome, dot: "bg-emerald-400" };
  return { label: "ready", dot: "bg-zinc-500" };
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
  const rows = useMemo(
    () =>
      orderGoalThreadsByHandoff(
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
      ),
    [shells, environmentId, goalId],
  );

  return (
    <section className="mt-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-3xs font-medium tracking-wider text-muted-foreground/70 uppercase">
          Threads
        </h3>
        <span className="rounded-full border border-border/60 px-1.5 text-3xs tabular-nums text-muted-foreground/70">
          {rows.length}
        </span>
        <span className="ml-auto text-3xs text-muted-foreground/60">handoff order</span>
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
                  title={shell.title}
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
                  <span className="flex items-center gap-1.5 text-3xs text-muted-foreground/70">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-1.5">
                      <span className={cn("size-1.5 rounded-full", chip.dot)} />
                      {chip.label}
                    </span>
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
