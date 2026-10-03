import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { useCallback } from "react";

import type { ThreadListV2ListItem } from "../threads/threadListV2";
import type { ThreadSearchArchivedItem } from "../threads/threadSearch.loom";
import {
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

type ThreadShortcutListItem =
  | ThreadListV2ListItem
  | { readonly type: "v2-show-more" }
  | ThreadSearchArchivedItem; // loom: archived search hits jump like any row

export function threadJumpIndex(command: HardwareKeyboardCommand) {
  return THREAD_JUMP_KEYBINDING_COMMANDS.findIndex((candidate) => candidate === command);
}

/** Uses the rendered list so filters and shelves keep their order. */
export function threadJumpTarget(
  items: ReadonlyArray<ThreadShortcutListItem>,
  command: HardwareKeyboardCommand,
) {
  let index = threadJumpIndex(command);
  if (index < 0) return null;
  for (const item of items) {
    const thread =
      item.type === "v2-thread"
        ? item.item.thread
        : item.type === "search-archived" // loom
          ? { environmentId: item.match.environmentId, id: item.match.threadId }
          : null;
    if (thread !== null && index-- === 0) return thread;
  }
  return null;
}

export function useThreadJumpShortcuts(
  items: ReadonlyArray<ThreadShortcutListItem>,
  onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void, // loom: archived hits have no shell
) {
  const jumpToThread = useCallback(
    (command: HardwareKeyboardCommand) => {
      const thread = threadJumpTarget(items, command);
      if (thread !== null) onSelectThread(thread);
      return true;
    },
    [items, onSelectThread],
  );
  useHardwareKeyboardCommand(THREAD_JUMP_KEYBINDING_COMMANDS, jumpToThread);
}
