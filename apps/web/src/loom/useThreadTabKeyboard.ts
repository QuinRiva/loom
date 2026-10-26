/**
 * loom: keyboard bindings for centre-panel thread tabs, a `tab.*` family apart from the sidebar's
 * `thread.*`. It runs in the capture phase (so composer and terminal handlers cannot swallow tab
 * keys), so it must never `preventDefault()` a non-`tab.*` command. Close and reopen consume even as
 * a no-op, shielding a bound key from the browser; traversal and jump only when they resolve.
 */
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { isTerminalFocused } from "../lib/terminalFocus";
import {
  resolveShortcutCommand,
  tabJumpIndexFromCommand,
  tabTraversalDirectionFromCommand,
} from "../keybindings";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useThreadTabActions } from "./useThreadTabsSync";

export function useThreadTabKeyboard(activeRouteRef: ScopedThreadRef | null): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const actions = useThreadTabActions(activeRouteRef);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        // Only the flags a shipped default `when` clause references, so this resolves exactly as every
        // other listener does and a `when`-gated command elsewhere never loses to a stale resolution.
        context: {
          terminalFocus: isTerminalFocused(),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (!command) return;

      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (command === "tab.close") {
        if (!activeRouteRef) return;
        consume();
        actions.closeTab(activeRouteRef);
        return;
      }

      if (command === "tab.reopenClosed") {
        consume();
        actions.reopenClosed();
        return;
      }

      const direction = tabTraversalDirectionFromCommand(command);
      if (direction !== null) {
        if (actions.goAdjacentTab(direction)) consume();
        return;
      }

      const jumpIndex = tabJumpIndexFromCommand(command);
      if (jumpIndex !== null && actions.jumpToTab(jumpIndex)) consume();
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [actions, activeRouteRef, keybindings]);
}
