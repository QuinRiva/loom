import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { RowPressable } from "../../components/RowPressable";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { selectedThreadRowColors, THREAD_LIST_V2_MONO_FONT } from "./thread-list-v2-row-appearance";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

/**
 * A search hit on a root the client holds no shell for (archived roots), drawn
 * from the match payload alone. Opening it navigates by id; the thread screen
 * loads the detail itself. No swipe actions: restoring lives in Archived threads.
 */
export const ArchivedSearchResultRow = memo(function ArchivedSearchResultRow(props: {
  readonly match: EnvironmentThreadSearchMatch;
  readonly searchQuery: string;
  readonly pane?: "sidebar";
  readonly selected?: boolean;
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
}) {
  const { match } = props;
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const mutedClassName = selected
    ? selectedThreadRowColors.mutedForegroundClassName
    : sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted";
  return (
    <RowPressable
      interactionClassName={sidebarPane ? "bg-thread-hover" : "bg-row-hover"}
      interactionOpacity={selected ? 0 : 1}
      accessibilityLabel={`${match.title}, archived`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={
        sidebarPane ? cn("rounded-xl", selected ? "bg-thread-selected" : "bg-drawer") : "bg-screen"
      }
      onPress={() =>
        props.onSelectThread({ environmentId: match.environmentId, id: match.threadId })
      }
    >
      <View
        className={cn(
          "min-h-[44px] flex-row items-center gap-2.5 py-2",
          sidebarPane ? "px-3" : "px-5",
        )}
      >
        <View className="min-w-0 flex-1">
          <Text
            className={cn(
              "text-base",
              selected
                ? selectedThreadRowColors.foregroundClassName
                : sidebarPane
                  ? "text-drawer-foreground"
                  : "text-foreground",
            )}
            numberOfLines={1}
          >
            {match.title || "Untitled thread"}
          </Text>
          <ThreadSearchMatchExcerpt
            sidebar={sidebarPane}
            match={match}
            query={props.searchQuery}
            selected={selected}
          />
        </View>
        <View className="rounded-full border border-border-subtle px-1.5 py-0.5">
          <Text className={cn("text-3xs font-t3-bold", mutedClassName)}>Archived</Text>
        </View>
        <Text
          className={cn("text-sm tabular-nums", mutedClassName)}
          style={{ fontFamily: THREAD_LIST_V2_MONO_FONT }}
        >
          {relativeTime(match.updatedAt)}
        </Text>
      </View>
    </RowPressable>
  );
});
