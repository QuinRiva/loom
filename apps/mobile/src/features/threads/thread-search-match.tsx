import { findSearchTokenRanges, splitSearchText } from "@t3tools/shared/paletteSearch";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
// loom: every indexed source, labelled, and the sub-thread line
import {
  threadSearchExcerptLabel,
  threadSearchMatchedSubThreadTitle,
  threadSearchShowsExcerpt, // loom: a heading over its sub-thread rows has no excerpt
} from "@t3tools/client-runtime/state/loom/threadSearch";

import { T, Var } from "gt-react-native"; // loom: the sub-thread line

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

export function ThreadSearchMatchExcerpt(props: {
  // loom: a sub-thread row passes its own hit, which has no shell fields
  readonly match: Pick<
    EnvironmentThreadSearchMatch,
    "source" | "snippet" | "matchedThreadId" | "matchedThreadTitle" | "subThreads"
  >;
  readonly query: string;
  readonly selected?: boolean;
  readonly compact?: boolean;
  readonly sidebar?: boolean;
}) {
  // loom: a hit on the root's own title has no label; the row already shows the title
  const label = threadSearchExcerptLabel(props.match);
  if (label === null || !threadSearchShowsExcerpt(props.match)) return null; // loom: heading
  const isUser = props.match.source === "user";
  const parts = splitSearchText(
    props.match.snippet,
    findSearchTokenRanges(props.match.snippet, props.query),
  );
  // loom: the sub-thread gets its own line so its title never crowds out the matched words
  const subThreadTitle = threadSearchMatchedSubThreadTitle(props.match);
  const mutedClassName = props.selected
    ? "text-thread-selected-foreground-muted"
    : props.sidebar
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted";
  return (
    <>
      <Text className={cn(props.compact ? "text-sm" : "text-xs", mutedClassName)} numberOfLines={1}>
        <Text
          className={cn(
            props.compact ? "text-sm font-t3-medium" : "text-xs font-t3-medium",
            props.selected
              ? "text-thread-selected-foreground"
              : isUser
                ? props.sidebar
                  ? "text-drawer-foreground-muted"
                  : "text-foreground-secondary"
                : "text-adaptive-emerald-600-400",
          )}
        >
          {label}{" "}
        </Text>
        {parts.map((part) => (
          <Text
            className={cn(
              props.compact ? "text-sm" : "text-xs",
              part.highlighted && "font-t3-bold",
              props.selected
                ? "text-thread-selected-foreground"
                : part.highlighted
                  ? props.sidebar
                    ? "text-drawer-foreground"
                    : "text-foreground"
                  : props.sidebar
                    ? "text-drawer-foreground-muted"
                    : "text-foreground-muted",
            )}
            key={part.start}
          >
            {part.text}
          </Text>
        ))}
      </Text>
      {subThreadTitle === null ? null : (
        <Text
          className={cn(props.compact ? "text-sm" : "text-xs", mutedClassName)}
          numberOfLines={1}
        >
          <T>
            Sub-thread: <Var>{subThreadTitle}</Var>
          </T>
        </Text>
      )}
    </>
  );
}
