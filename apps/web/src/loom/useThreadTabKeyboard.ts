/**
 * loom: keyboard bindings for centre-panel thread tabs.
 *
 * The tab strip owns its own command family, so the sidebar keeps
 * `thread.previous` / `thread.next` / `thread.jump.N` unchanged:
 *   - `tab.previous` / `tab.next` (`mod+alt+[` / `mod+alt+]`) → prev/next tab
 *     (strip order, no wrap)
 *   - `tab.jump.N` (`mod+alt+1..9`) → activate tab N
 *   - `tab.close` (`mod+w`) → close the active tab
 *   - `tab.reopenClosed` (`mod+shift+t`) → reopen the most recently closed tab
 *
 * This hook must never resolve or `preventDefault()` a non-`tab.*` command —
 * it runs in the capture phase (so composer/terminal bubble handlers cannot
 * swallow tab keys) and would otherwise pre-empt every other listener. A tab
 * action that cannot act (no tabs, index out of range) does nothing at all,
 * including no `preventDefault()`, so the key falls through untouched.
 *
 * The shortcut context mirrors the sidebars' (`terminalFocus` +
 * `modelPickerOpen`): `terminalFocus` distinguishes `tab.close` from
 * `terminal.close` on `mod+w`, and `modelPickerOpen` keeps this hook's
 * resolution identical to every other listener's, so a `when`-gated command
 * elsewhere can never lose to a stale resolution here.
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
