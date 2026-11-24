import {
  threadSearchTarget,
  withThreadSearchSubRows,
  type ThreadSearchSubRow,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CornerDownRightIcon } from "lucide-react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "~/components/CommandPalette.logic";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { ArchivedBadge } from "./ArchivedSearchResultRow";
import { openThreadSearchTarget } from "./threadSearchSwitches";

/**
 * The palette's thread groups with each listed top-level thread's sub-thread rows directly after
 * it, as items whose arrow icon indents them under it.
 */
export function withPaletteSubThreadItems(
  groups: ReadonlyArray<CommandPaletteGroup>,
  subRows: ReadonlyMap<string, ReadonlyArray<ThreadSearchSubRow>>,
  input: {
    readonly query: string;
    readonly navigateTo: (ref: ScopedThreadRef) => Promise<unknown>;
    readonly unfold: (root: ThreadSearchSubRow["root"]) => void;
  },
): CommandPaletteGroup[] {
  if (subRows.size === 0) return [...groups];
  const keyByValue = new Map<string, string>(
    [...subRows].flatMap(([key, [first]]) =>
      first === undefined
        ? []
        : [[`thread:${first.root.environmentId}:${first.root.threadId}`, key] as const],
    ),
  );
  const icon = <CornerDownRightIcon className={cn(ITEM_ICON_CLASS, "ms-4")} />;
  const itemOf = (row: ThreadSearchSubRow): CommandPaletteActionItem =>
    row.kind === "fold"
      ? {
          kind: "action",
          value: `sub-thread-fold:${row.key}`,
          searchTerms: [],
          title: `+${row.omitted} more sub-thread${row.omitted === 1 ? "" : "s"}`,
          icon,
          keepOpen: true,
          run: async () => input.unfold(row.root),
        }
      : {
          kind: "action",
          value: `sub-thread:${row.key}`,
          searchTerms: [],
          title: row.match.title || "Untitled thread",
          icon,
          threadContentMatch: {
            source: row.match.source,
            snippet: row.match.snippet,
            matchedThreadId: null,
            matchedThreadTitle: null,
            query: input.query,
          },
          ...(row.match.messageCreatedAt
            ? { timestamp: formatRelativeTimeLabel(row.match.messageCreatedAt) }
            : {}),
          ...(row.match.archivedAt === null ? {} : { titleTrailingContent: <ArchivedBadge /> }),
          run: () => openThreadSearchTarget(threadSearchTarget(row), input.query, input.navigateTo),
        };
  return groups.map((group) =>
    group.value !== "threads-search" && group.value !== "threads-messages"
      ? group
      : {
          ...group,
          items: withThreadSearchSubRows(
            group.items,
            (item) => keyByValue.get(item.value) ?? null,
            subRows,
          ).map((row) => (row.kind === "subThread" || row.kind === "fold" ? itemOf(row) : row)),
        },
  );
}
