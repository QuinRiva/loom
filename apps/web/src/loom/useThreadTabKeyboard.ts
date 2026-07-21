/**
 * loom: keyboard bindings for centre-panel thread tabs.
 *
 * Repurposes the existing thread-traversal bindings to operate on the tab strip
 * when ≥1 tab is open, and adds tab close / reopen:
 *   - `thread.previous` / `thread.next` → prev/next tab (strip order, no wrap)
 *   - `thread.jump.N` → activate tab N
 *   - `tab.close` (`mod+w`) → close the active tab
 *   - `tab.reopenClosed` (`mod+shift+t`) → reopen the most recently closed tab
 *
 * When the tab set is empty the traversal/jump bindings are left unhandled so
 * `Sidebar`'s existing list traversal keeps working unchanged. The listener runs
 * in the capture phase and `preventDefault()`s what it handles, so `Sidebar`'s
 * bubble-phase handler (which bails on `event.defaultPrevented`) never double-
 * fires the same command.
 */
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { isTerminalFocused } from "../lib/terminalFocus";
import {
  resolveShortcutCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { selectActiveGroup, useThreadTabsStore } from "./threadTabsStore";
import { useThreadTabActions } from "./useThreadTabsSync";

export function useThreadTabKeyboard(activeRouteRef: ScopedThreadRef | null): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const actions = useThreadTabActions(activeRouteRef);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
        },
      });
      if (!command) return;

      if (command === "tab.close") {
        if (!activeRouteRef) return;
        event.preventDefault();
        event.stopPropagation();
        actions.closeTab(activeRouteRef);
        return;
      }

      if (command === "tab.reopenClosed") {
        event.preventDefault();
        event.stopPropagation();
        actions.reopenClosed();
        return;
      }

      const hasTabs = (selectActiveGroup(useThreadTabsStore.getState())?.tabs.length ?? 0) > 0;
      if (!hasTabs) return;

      const direction = threadTraversalDirectionFromCommand(command);
      if (direction !== null) {
        event.preventDefault();
        event.stopPropagation();
        actions.goAdjacentTab(direction);
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command);
      if (jumpIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        actions.jumpToTab(jumpIndex);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [actions, activeRouteRef, keybindings]);
}
