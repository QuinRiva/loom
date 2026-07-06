import { AlertTriangleIcon } from "lucide-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo, useState } from "react";
import type { WorkstreamWorktreeEntry, WorkstreamWorktreeStaleReason } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  DiagnosticsLastChecked,
  DiagnosticsRefreshButton,
  formatBytes,
  SettingsPageContainer,
  SettingsSection,
  StatBlock,
  StatsGrid,
} from "./settingsLayout";

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "—";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Human-facing "why kept" labels for the classifier's disposition/reason truth.
// `recently-finished` is provably dead and merely younger than the reap age, so
// it presents (and behaves) like `reapable`: the reaper's job, no manual action.
function classify(entry: WorkstreamWorktreeEntry): {
  label: string;
  tone: "neutral" | "warn";
  removable: boolean;
} {
  if (entry.disposition === "active") return { label: "Active", tone: "neutral", removable: false };
  if (entry.disposition === "reapable" || entry.reason === "recently-finished") {
    return { label: "Auto-reap soon", tone: "neutral", removable: false };
  }
  const map: Record<WorkstreamWorktreeStaleReason, { label: string; tone: "neutral" | "warn" }> = {
    orphaned: { label: "Orphaned", tone: "warn" },
    unmanaged: { label: "Unmanaged", tone: "warn" },
    cancelled: { label: "Cancelled wip", tone: "neutral" },
    conflicted: { label: "Conflicted", tone: "warn" },
    "fanin-pending": { label: "Fan-in pending", tone: "neutral" },
    dirty: { label: "Uncommitted changes", tone: "warn" },
    unmerged: { label: "Unmerged", tone: "neutral" },
    "recently-finished": { label: "Auto-reap soon", tone: "neutral" },
  };
  const resolved =
    entry.reason === null ? { label: "Stale", tone: "warn" as const } : map[entry.reason];
  return { ...resolved, removable: true };
}

function branchState(entry: WorkstreamWorktreeEntry): string {
  const merge =
    entry.branch === null
      ? "detached"
      : entry.merged === null
        ? "merge unknown"
        : entry.merged
          ? "merged"
          : "unmerged";
  return `${merge} · ${entry.dirty ? "dirty" : "clean"}`;
}

function worktreeName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

function WhyKeptPill({ label, tone }: { label: string; tone: "neutral" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "warn"
          ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
          : "border-border/70 text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function OwnerCell({ entry }: { entry: WorkstreamWorktreeEntry }) {
  if (entry.owner === null) {
    return <span className="text-muted-foreground/60 italic">no owning thread</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate text-foreground">{entry.owner.title}</span>
      {entry.owner.role ? (
        <span className="shrink-0 text-[11px] text-muted-foreground/60">{entry.owner.role}</span>
      ) : null}
    </span>
  );
}

export function WorktreesSettingsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const removeWorktree = useAtomCommand(serverEnvironment.removeWorkstreamWorktree, {
    reportFailure: false,
  });
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workstreamWorktrees({ environmentId, input: {} }),
  );

  const [pending, setPending] = useState<WorkstreamWorktreeEntry | null>(null);
  const [ackDirty, setAckDirty] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  const entries = data?.entries ?? [];
  const stats = useMemo(() => {
    let totalBytes = 0;
    let stale = 0;
    let reapPending = 0;
    for (const entry of entries) {
      if (entry.sizeBytes !== null) totalBytes += entry.sizeBytes;
      if (entry.disposition === "reapable" || entry.reason === "recently-finished") {
        reapPending += 1;
      } else if (entry.disposition === "stale") {
        stale += 1;
      }
    }
    return { count: entries.length, totalBytes, stale, reapPending };
  }, [entries]);

  const openRemove = useCallback((entry: WorkstreamWorktreeEntry) => {
    setPending(entry);
    setAckDirty(false);
  }, []);

  const confirmRemove = useCallback(() => {
    if (pending === null || environmentId === null) return;
    const entry = pending;
    setIsRemoving(true);
    void (async () => {
      const result = await removeWorktree({
        environmentId,
        input: {
          worktreePath: entry.worktreePath,
          acknowledgeDirty: entry.dirty,
          acknowledgeUnmerged: entry.merged !== true,
        },
      });
      setIsRemoving(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not remove worktree",
            description: failure instanceof Error ? failure.message : "Removal failed.",
          });
        }
        return;
      }
      if (!result.value.removed) {
        toastManager.add({
          type: "error",
          title: "Worktree not removed",
          description: result.value.message ?? "The server refused the removal.",
        });
        refresh();
        return;
      }
      toastManager.add({
        type: "success",
        title: "Worktree removed",
        description: result.value.deletedBranch
          ? `Deleted checkout and merged branch ${result.value.deletedBranch}.`
          : "Deleted checkout; the unmerged branch was kept.",
      });
      setPending(null);
      refresh();
    })();
  }, [pending, environmentId, removeWorktree, refresh]);

  const pendingUnmerged = pending !== null && pending.merged !== true;
  const removeDisabled = isRemoving || (pending !== null && pending.dirty && !ackDirty);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Worktrees"
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={data?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isPending}
              label="Refresh worktrees"
              onClick={refresh}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock label="Worktrees" value={data ? String(stats.count) : "..."} />
          <StatBlock
            label="Disk"
            value={data ? formatBytes(stats.totalBytes) : "..."}
            tooltip="Total resident disk across worktrees whose size the scan could measure. Cells that timed out are excluded."
          />
          <StatBlock
            label="Stale"
            value={data ? String(stats.stale) : "..."}
            tone={data && stats.stale > 0 ? "warning" : "default"}
            tooltip="Worktrees the auto-reaper deliberately declined to remove — they need a human look."
          />
          <StatBlock
            label="Auto-reap pending"
            value={data ? String(stats.reapPending) : "..."}
            tooltip="Provably-dead worktrees the reaper will remove on its next sweep."
          />
        </StatsGrid>
        {error ? (
          <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            <div className="flex items-start gap-2 text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        ) : null}
        <ScrollArea
          chainVerticalScroll
          scrollFade
          hideScrollbars
          className="w-full max-w-full border-t border-border/60"
        >
          <table className="w-full min-w-[860px] table-fixed text-left text-xs">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[24%]" />
              <col className="w-[15%]" />
              <col className="w-[7%]" />
              <col className="w-[9%]" />
              <col className="w-[15%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
              <tr>
                <th className="px-4 py-2.5 font-semibold sm:pl-5">Worktree</th>
                <th className="px-3 py-2.5 font-semibold">Owner</th>
                <th className="px-3 py-2.5 font-semibold">Why kept</th>
                <th className="px-3 py-2.5 font-semibold">Age</th>
                <th className="px-3 py-2.5 text-right font-semibold">Size</th>
                <th className="px-3 py-2.5 font-semibold">Branch state</th>
                <th className="p-2.5 text-right font-semibold sm:pr-5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                    {isPending && data === null ? "Scanning worktrees..." : "No worktrees found."}
                  </td>
                </tr>
              ) : null}
              {entries.map((entry) => {
                const meta = classify(entry);
                return (
                  <tr key={entry.worktreePath} className="hover:bg-muted/20">
                    <td className="px-4 py-2.5 align-middle sm:pl-5">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="block truncate font-medium text-foreground">
                              {worktreeName(entry.worktreePath)}
                              {entry.isMain ? (
                                <span className="ml-1.5 text-[11px] text-muted-foreground/60">
                                  main
                                </span>
                              ) : null}
                            </span>
                          }
                        />
                        <TooltipPopup
                          side="top"
                          className="max-w-[min(520px,calc(100vw-2rem))] break-all font-mono text-[11px]"
                        >
                          {entry.worktreePath}
                          <div className="mt-1 text-muted-foreground">{entry.projectName}</div>
                        </TooltipPopup>
                      </Tooltip>
                    </td>
                    <td className="min-w-0 px-3 py-2.5 align-middle">
                      <OwnerCell entry={entry} />
                    </td>
                    <td className="px-3 py-2.5 align-middle">
                      <WhyKeptPill label={meta.label} tone={meta.tone} />
                    </td>
                    <td className="px-3 py-2.5 align-middle font-mono tabular-nums text-muted-foreground">
                      {formatAge(entry.ageMs)}
                    </td>
                    <td className="px-3 py-2.5 text-right align-middle font-mono tabular-nums text-muted-foreground">
                      {entry.sizeBytes === null ? "—" : formatBytes(entry.sizeBytes)}
                    </td>
                    <td className="px-3 py-2.5 align-middle text-muted-foreground">
                      {branchState(entry)}
                    </td>
                    <td className="p-2.5 text-right align-middle sm:pr-5">
                      {meta.removable ? (
                        <Button size="xs" variant="outline" onClick={() => openRemove(entry)}>
                          Remove…
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollArea>
      </SettingsSection>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (isRemoving) return;
          if (!open) setPending(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove worktree?</AlertDialogTitle>
          </AlertDialogHeader>
          {pending ? (
            <div className="space-y-3 text-sm">
              <p className="truncate">
                <span className="font-medium text-foreground">
                  {worktreeName(pending.worktreePath)}
                </span>
                <span className="text-muted-foreground">
                  {" · "}
                  {pending.sizeBytes === null ? "size unknown" : formatBytes(pending.sizeBytes)}
                  {" · "}
                  {classify(pending).label.toLowerCase()}
                </span>
              </p>
              {pending.dirty || pendingUnmerged ? (
                <div className="rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                  {pending.dirty ? (
                    <span>Uncommitted changes will be permanently deleted. </span>
                  ) : null}
                  {pendingUnmerged && pending.branch ? (
                    <span>
                      The branch <span className="font-mono">{pending.branch}</span> is not merged —
                      the branch itself is kept.
                    </span>
                  ) : pendingUnmerged ? (
                    <span>The branch is not merged — it is kept.</span>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The branch is fully merged and will be deleted along with the checkout.
                </p>
              )}
              {pending.dirty ? (
                <label className="flex items-center gap-2 text-xs text-foreground">
                  <Checkbox
                    checked={ackDirty}
                    onCheckedChange={(checked) => setAckDirty(checked === true)}
                  />
                  Delete the uncommitted changes
                </label>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isRemoving}
              render={<Button variant="outline" disabled={isRemoving} />}
            >
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" onClick={confirmRemove} disabled={removeDisabled}>
              {isRemoving ? "Removing…" : "Remove worktree"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
