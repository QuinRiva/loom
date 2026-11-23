/**
 * loom: one row of the Tasks tab (§3 of plans/mobile-goal-tasks/plan.mdx), drawn from a
 * `GoalTaskRow`. Read-only: a ring or tick is drawn, never pressed. Taps fold, open a run, show a
 * task's full text or open a thread; nothing here writes to the goal.
 */
import {
  isRunning,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
} from "@t3tools/client-runtime/state/loom/workstreamNodes";
import type { ThreadId } from "@t3tools/contracts";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { GoalTaskRow } from "./goalTaskRows.loom";
import { rowCopy, rowTrailing } from "./workstreamCopy.loom";

const MONO_FONT = "Menlo";
const INDENT = 15;
const LEFT = 12;

/** The Graph | Tasks switch and the To do | All filter: PillButton's look, with a selected state. */
export function Segment(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      hitSlop={4}
      className={cn(
        "min-h-8 justify-center rounded-full border px-3 active:opacity-70",
        props.selected
          ? "border-adaptive-blue-300-a50-blue-400-a28 bg-adaptive-blue-500-a20-blue-400-a15"
          : "border-border",
      )}
    >
      <Text
        className={cn(
          "text-[13px] font-t3-bold",
          props.selected ? "text-primary-text" : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

type Tone = "warning" | "error";

/** What a thread row shows besides its place in the tree; compared by value. */
export interface TaskThreadDisplay {
  readonly title: string;
  readonly role: string;
  readonly state: string;
  readonly stateTone: Tone | null;
  readonly trailing: { readonly text: string; readonly tone: Tone | null };
  readonly dot: "error" | "warning" | "running" | "done" | "idle";
}

/** The Graph row's words for one owning thread. Pass `now` from `useNowMinuteMs`. */
export function taskThreadDisplay(
  node: WorkstreamNode,
  byId: WorkstreamNodeIndex,
  now: number,
): TaskThreadDisplay {
  const copy = rowCopy(node, byId, now);
  const trailing = rowTrailing(node, now);
  return {
    title: node.title,
    role: copy.role,
    state: copy.state,
    stateTone: copy.attention?.tone ?? (copy.longStep ? "warning" : null),
    trailing:
      "chip" in trailing
        ? { text: trailing.chip, tone: trailing.tone }
        : { text: trailing.age, tone: null },
    dot:
      node.reasons[0] === "error"
        ? "error"
        : copy.attention
          ? "warning"
          : node.outcome === "done"
            ? "done"
            : node.outcome === null && isRunning(node)
              ? "running"
              : "idle",
  };
}

const TONE_TEXT = {
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
} satisfies Record<Tone, string>;

const DOT_CLASS = {
  error: "bg-danger-foreground",
  warning: "bg-warning-foreground",
  running: "bg-adaptive-sky-600-400",
  done: "bg-adaptive-emerald-600-400",
  idle: "border-[1.5px] border-foreground-muted",
} satisfies Record<TaskThreadDisplay["dot"], string>;

/** One vertical guide per level above the row, as the mockup's tree draws them. */
function Guides(props: { readonly depth: number }) {
  return Array.from({ length: props.depth }, (_, level) => (
    <View
      key={level}
      pointerEvents="none"
      className="absolute top-0 bottom-0 w-px bg-subtle-strong"
      style={{ left: LEFT + 8 + level * INDENT }}
    />
  ));
}

function Tick(props: { readonly size: number }) {
  return (
    <SymbolView
      name="checkmark"
      size={props.size}
      tintColorClassName="accent-adaptive-emerald-600-400"
    />
  );
}

function Ring(props: { readonly size: number }) {
  return (
    <View
      className="rounded-full border-[1.5px] border-foreground-tertiary"
      style={{ width: props.size, height: props.size }}
    />
  );
}

export interface WorkstreamTaskRowProps {
  readonly row: GoalTaskRow;
  /** Set for a `thread` row whose thread the phone holds. */
  readonly thread: TaskThreadDisplay | null;
  /** The thread open beside the pane. */
  readonly selected: boolean;
  readonly onToggle: (key: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onLongPressThread: (threadId: ThreadId) => void;
}

function TaskRow(props: {
  readonly row: Extract<GoalTaskRow, { kind: "task" }>;
  readonly onToggle: (key: string) => void;
}) {
  const { row } = props;
  const parent = row.count !== null;
  const left = LEFT + row.depth * INDENT;
  const mark = parent ? (
    <SymbolView
      name={row.folded ? "chevron.right" : "chevron.down"}
      size={12}
      tintColorClassName="accent-foreground-tertiary"
    />
  ) : row.done ? (
    <Tick size={13} />
  ) : (
    <Ring size={14} />
  );
  return (
    <View
      className={cn("flex-row", row.marked && "bg-adaptive-blue-50-blue-400-a14")}
      style={{ paddingLeft: parent ? 0 : left }}
    >
      <Guides depth={row.depth} />
      {row.marked ? <View className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary" /> : null}
      {parent ? (
        // The chevron's side of the row folds the subtree to this one row.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={row.folded ? "Expand sub-tasks" : "Collapse sub-tasks"}
          onPress={() => props.onToggle(`fold:${row.taskId}`)}
          className="items-end pt-[9px] pr-2"
          style={{ width: left + 26 }}
        >
          <View className="h-[18px] w-[18px] items-center justify-center">{mark}</View>
        </Pressable>
      ) : (
        <View className="mr-2 h-[18px] w-[18px] items-center justify-center self-start mt-[9px]">
          {mark}
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityHint={row.fullText ? "Shortens the task" : "Shows the whole task"}
        onPress={() => props.onToggle(`text:${row.taskId}`)}
        className="min-w-0 flex-1 flex-row py-2 pr-3"
      >
        <View className="min-w-0 flex-1">
          {row.marked ? (
            <Text className="mb-0.5 text-[10px] font-t3-bold tracking-wider text-primary-text">
              THIS THREAD'S TASK
            </Text>
          ) : null}
          <Text
            className={cn(
              "text-[14.5px] leading-[19px]",
              row.done ? "text-foreground-muted" : parent && "font-t3-bold",
            )}
            numberOfLines={row.fullText ? undefined : parent ? 2 : 3}
          >
            {row.text}
          </Text>
        </View>
        {row.count ? (
          <Text
            className={cn(
              "ml-2 mt-0.5 text-xs tabular-nums",
              row.count.done === row.count.total
                ? "text-adaptive-emerald-600-400"
                : "text-foreground-muted",
            )}
            style={{ fontFamily: MONO_FONT }}
          >
            {row.count.done}/{row.count.total}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

function ThreadRow(props: WorkstreamTaskRowProps & { readonly threadId: ThreadId }) {
  const { row, thread, threadId } = props;
  if (row.kind !== "thread") return null;
  // Aligned with the owning task's text, one level in from its mark.
  const left = LEFT + Math.max(row.depth - 1, 0) * INDENT + 26;
  const open = () => props.onOpenThread(threadId);
  const longPress = () => props.onLongPressThread(threadId);
  if (row.quiet || !thread)
    return (
      <View style={{ paddingLeft: left }} className="pr-3">
        <Guides depth={row.depth} />
        <Pressable
          accessibilityRole="button"
          onPress={open}
          onLongPress={longPress}
          className={cn(
            "flex-row items-center gap-1.5 rounded-md py-1.5 active:bg-row-hover",
            props.selected && "bg-subtle-strong",
          )}
        >
          <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
            {thread ? `${thread.title} · ${thread.role}` : "Thread not loaded"}
          </Text>
          <SymbolView name="chevron.right" size={10} tintColorClassName="accent-foreground-muted" />
        </Pressable>
      </View>
    );
  const attention = thread.dot === "warning" || thread.dot === "error";
  return (
    <View style={{ paddingLeft: left }} className="pr-3 pb-1.5">
      <Guides depth={row.depth} />
      <Pressable
        accessibilityRole="button"
        onPress={open}
        onLongPress={longPress}
        className={cn(
          "flex-row items-start gap-2 rounded-[10px] border px-2.5 py-1.5 active:opacity-70",
          props.selected
            ? "border-adaptive-blue-300-a50-blue-400-a28 bg-subtle-strong"
            : thread.dot === "error"
              ? "border-danger-border bg-danger"
              : attention
                ? "border-warning-border bg-warning"
                : "border-border bg-card",
        )}
      >
        <View className={cn("mt-[5px] h-[9px] w-[9px] rounded-full", DOT_CLASS[thread.dot])} />
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="shrink text-[13.5px] font-t3-medium" numberOfLines={1}>
              {thread.title}
            </Text>
            <View className="flex-1" />
            <Text
              className={cn(
                "text-xs",
                thread.trailing.tone
                  ? cn("font-t3-bold", TONE_TEXT[thread.trailing.tone])
                  : "text-foreground-muted",
              )}
              style={thread.trailing.tone ? undefined : { fontFamily: MONO_FONT }}
            >
              {thread.trailing.text}
            </Text>
          </View>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {thread.role} ·{" "}
            <Text
              className={cn(
                "text-xs",
                thread.stateTone ? TONE_TEXT[thread.stateTone] : "text-foreground-muted",
              )}
            >
              {thread.state}
            </Text>
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

function WorkstreamTaskRowView(props: WorkstreamTaskRowProps) {
  const { row } = props;
  switch (row.kind) {
    case "caption":
      return (
        <View className="flex-row items-center gap-2 px-3 pt-1.5 pb-1">
          <View className="h-[18px] w-[18px] items-center justify-center">
            {row.done ? <Tick size={11} /> : <Ring size={11} />}
          </View>
          <Text className="shrink text-[12.5px] text-foreground-muted" numberOfLines={1}>
            {row.text}
          </Text>
        </View>
      );
    case "task":
      return <TaskRow row={row} onToggle={props.onToggle} />;
    case "run":
    case "threads":
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: row.open }}
          onPress={() => props.onToggle(row.key)}
          className="flex-row items-center py-1.5 pr-3 active:bg-row-hover"
          style={{ paddingLeft: LEFT + row.depth * INDENT }}
        >
          <Guides depth={row.depth} />
          <View className="mr-2 h-[18px] w-[18px] items-center justify-center">
            {row.kind === "run" ? <Tick size={12} /> : null}
          </View>
          <Text className="min-w-0 flex-1 text-[12.5px] text-foreground-muted" numberOfLines={1}>
            {row.kind === "run"
              ? row.label
              : `${row.count} thread${row.count === 1 ? "" : "s"} finished`}
          </Text>
          <SymbolView
            name={row.open ? "chevron.down" : "chevron.right"}
            size={11}
            tintColorClassName="accent-foreground-tertiary"
          />
        </Pressable>
      );
    case "thread":
      return <ThreadRow {...props} threadId={row.threadId} />;
  }
}

/** A row repaints only when its row, its thread's words or its selection change. */
export const WorkstreamTaskRow = memo(
  WorkstreamTaskRowView,
  (before, after) =>
    before.selected === after.selected &&
    before.onToggle === after.onToggle &&
    before.onOpenThread === after.onOpenThread &&
    before.onLongPressThread === after.onLongPressThread &&
    JSON.stringify(before.row) === JSON.stringify(after.row) &&
    JSON.stringify(before.thread) === JSON.stringify(after.thread),
);
