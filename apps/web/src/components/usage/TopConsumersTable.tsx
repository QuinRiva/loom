import { ChevronDownIcon, ChevronRightIcon, CornerDownRightIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ServerUsageBreakdownConsumer } from "@t3tools/contracts";
import {
  formatTokenCount,
  formatUsd,
  groupUsageConsumers,
  sortUsageRows,
  toggleUsageSort,
  type UsageConsumerGroup,
  type UsageSort,
} from "@t3tools/client-runtime/usageDashboard";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "../ui/table";
import { SortableColumnHead } from "./SortableColumnHead";

type ConsumerColumn = "thread" | "turnCount" | "totalTokens" | "costUsd" | "lastActivityAt";

const COLUMN_VALUES: Record<ConsumerColumn, (group: UsageConsumerGroup) => number | string | null> =
  {
    thread: (group) => group.title,
    turnCount: (group) => group.turnCount,
    totalTokens: (group) => group.totalTokens,
    costUsd: (group) => group.costUsd,
    lastActivityAt: (group) => group.lastActivityAt,
  };

/**
 * Threads that drove the window's burn, rolled up to their workstream root
 * (§1.4). Root rows expand into member threads; any row clicks through to the
 * thread itself.
 */
export function TopConsumersTable({
  consumers,
  environmentId,
  emptyLabel,
}: {
  consumers: ReadonlyArray<ServerUsageBreakdownConsumer>;
  environmentId: EnvironmentId;
  emptyLabel: string;
}) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<UsageSort<ConsumerColumn>>({
    column: "costUsd",
    direction: "desc",
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(
    () => sortUsageRows(groupUsageConsumers(consumers), COLUMN_VALUES[sort.column], sort.direction),
    [consumers, sort],
  );
  const onSort = (column: ConsumerColumn) =>
    setSort((current) => toggleUsageSort(current, column, column === "thread" ? "asc" : "desc"));
  const toggleExpanded = (rootThreadId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(rootThreadId)) next.add(rootThreadId);
      return next;
    });
  const openThread = (threadId: ThreadId) =>
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });

  if (consumers.length === 0) {
    return <div className="px-4 py-6 text-center text-xs text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableColumnHead label="Thread" column="thread" sort={sort} onSort={onSort} />
          <SortableColumnHead
            label="Turns"
            column="turnCount"
            sort={sort}
            onSort={onSort}
            align="right"
          />
          <SortableColumnHead
            label="Tokens"
            column="totalTokens"
            sort={sort}
            onSort={onSort}
            align="right"
          />
          <SortableColumnHead
            label="Cost"
            column="costUsd"
            sort={sort}
            onSort={onSort}
            align="right"
          />
          <SortableColumnHead
            label="Last activity"
            column="lastActivityAt"
            sort={sort}
            onSort={onSort}
            align="right"
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const isExpanded = expanded.has(group.rootThreadId);
          return (
            <GroupRows
              key={group.rootThreadId}
              group={group}
              isExpanded={isExpanded}
              onToggle={() => toggleExpanded(group.rootThreadId)}
              onOpenThread={openThread}
            />
          );
        })}
      </TableBody>
    </Table>
  );
}

function GroupRows({
  group,
  isExpanded,
  onToggle,
  onOpenThread,
}: {
  group: UsageConsumerGroup;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => onOpenThread(group.rootThreadId)}>
        <TableCell>
          <div className="flex items-center gap-1.5">
            {group.expandable ? (
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-label={
                  isExpanded ? "Collapse workstream threads" : "Expand workstream threads"
                }
                className="-m-1 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle();
                }}
              >
                <ChevronIcon className="size-3.5" />
              </button>
            ) : (
              <span className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="max-w-64 truncate font-medium">
              {group.title ?? "Untitled thread"}
            </span>
            {group.expandable ? (
              <Badge size="sm" variant="outline" className="text-muted-foreground">
                {group.members.length} thread{group.members.length === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="text-right tabular-nums">{group.turnCount}</TableCell>
        <TableCell className="text-right tabular-nums">
          {formatTokenCount(group.totalTokens)}
        </TableCell>
        <TableCell className="text-right tabular-nums">{formatUsd(group.costUsd)}</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {formatRelativeTimeLabel(group.lastActivityAt)}
        </TableCell>
      </TableRow>
      {isExpanded
        ? group.members.map((member) => (
            <TableRow
              key={member.threadId}
              className="cursor-pointer bg-muted/20"
              onClick={() => onOpenThread(member.threadId)}
            >
              <TableCell>
                <div className="flex items-center gap-1.5 pl-5">
                  <CornerDownRightIcon
                    className="size-3 shrink-0 text-muted-foreground/50"
                    aria-hidden
                  />
                  <span
                    className={cn(
                      "max-w-60 truncate",
                      member.threadId === group.rootThreadId && "italic",
                    )}
                  >
                    {member.threadId === group.rootThreadId
                      ? "Root thread (direct usage)"
                      : (member.title ?? "Untitled thread")}
                  </span>
                  {member.role ? (
                    <Badge size="sm" variant="outline" className="text-muted-foreground">
                      {member.role}
                    </Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{member.turnCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatTokenCount(member.totalTokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatUsd(member.costUsd)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {formatRelativeTimeLabel(member.lastActivityAt)}
              </TableCell>
            </TableRow>
          ))
        : null}
    </>
  );
}
