import {
  threadSearchTarget,
  type ThreadSearchSubRow,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { memo } from "react";
import { Text as NativeText, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { selectedThreadRowColors } from "./thread-list-v2-row-appearance";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";
import { openThreadSearchTarget } from "./useFilteredThreadSearch.loom";

/**
 * A sub-thread's search row under its top-level thread, or the fold row that unfolds the rest of
 * that workstream's. Drawn from the match alone: most sub-threads have no shell on the phone.
 */
export const SubThreadSearchResultRow = memo(function SubThreadSearchResultRow(props: {
  readonly row: ThreadSearchSubRow;
  readonly searchQuery: string;
  /** The lists' drawer, or the iPad palette, whose rows are a fixed height and carry ⌘ hints. */
  readonly pane?: "sidebar" | "palette";
  readonly selected?: boolean;
  readonly height?: number;
  readonly shortcutIndex?: number;
  readonly onSelectThread?: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
  readonly onUnfold?: (root: EnvironmentThreadSearchMatch) => void;
  /** In place of opening or unfolding: the palette closes first, and opens through its own path. */
  readonly onPress?: () => void;
}) {
  const { row } = props;
  const sidebarPane = props.pane === "sidebar";
  const palette = props.pane === "palette";
  const selected = props.selected === true;
  const foregroundClassName = selected
    ? selectedThreadRowColors.foregroundClassName
    : sidebarPane
      ? "text-drawer-foreground"
      : "text-foreground";
  const mutedClassName = selected
    ? selectedThreadRowColors.mutedForegroundClassName
    : sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted";
  const title = row.kind === "fold" ? null : row.match.title || "Untitled thread";
  return (
    <RowPressable
      interactionClassName={sidebarPane ? "bg-thread-hover" : "bg-row-hover"}
      interactionOpacity={selected ? 0 : 1}
      accessibilityRole="button"
      accessibilityLabel={
        row.kind === "fold"
          ? `${row.omitted} more sub-threads of ${row.root.title}`
          : `${title}, sub-thread of ${row.root.title}${row.match.archivedAt === null ? "" : ", archived"}`
      }
      accessibilityState={{ selected }}
      className={cn(
        palette ? "mx-2 rounded-xl px-3" : sidebarPane ? "rounded-xl px-3" : "px-5",
        selected ? "bg-thread-selected" : sidebarPane ? "bg-drawer" : palette ? "" : "bg-screen",
      )}
      style={props.height === undefined ? undefined : { height: props.height }}
      onPress={() => {
        if (props.onPress) props.onPress();
        else if (row.kind === "fold") props.onUnfold?.(row.root);
        else if (props.onSelectThread)
          openThreadSearchTarget(threadSearchTarget(row), props.onSelectThread);
      }}
    >
      <View
        className={cn("flex-row items-stretch gap-2.5", palette ? "h-full py-1.5" : "py-1.5")}
        style={{ paddingLeft: palette ? 40 : 12 }}
      >
        <View className="w-0.5 rounded-full bg-border-subtle" />
        <View className="min-w-0 flex-1 justify-center">
          {row.kind === "fold" ? (
            <Text className={cn("text-sm font-t3-medium", mutedClassName)} numberOfLines={1}>
              {`+${row.omitted} more sub-threads`}
            </Text>
          ) : (
            <>
              <View className="flex-row items-center gap-2">
                <Text className={cn("shrink text-sm", foregroundClassName)} numberOfLines={1}>
                  {title}
                </Text>
                {row.match.archivedAt === null ? null : (
                  <View className="rounded-full border border-border-subtle px-1.5 py-0.5">
                    <Text className={cn("text-3xs font-t3-bold", mutedClassName)}>Archived</Text>
                  </View>
                )}
              </View>
              <ThreadSearchMatchExcerpt
                sidebar={sidebarPane}
                match={{
                  source: row.match.source,
                  snippet: row.match.snippet,
                  matchedThreadId: null,
                  matchedThreadTitle: null,
                }}
                query={props.searchQuery}
                selected={selected}
              />
            </>
          )}
        </View>
        {props.shortcutIndex !== undefined && props.shortcutIndex < 9 ? (
          <NativeText
            className={cn(
              "w-8 shrink-0 self-center text-right text-sm tabular-nums",
              mutedClassName,
            )}
          >
            ⌘{props.shortcutIndex + 1}
          </NativeText>
        ) : null}
      </View>
    </RowPressable>
  );
});
