// One right-panel width per workstream (plans/right-panel-carry/intent.mdx): every thread reads
// and writes its root's key, so moving inside a workstream never resizes the panel. A workstream
// never sized takes the width of the one shown last, and keeps it from then on.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useLayoutEffect } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { PREVIEW_PANEL_DEFAULT_WIDTH } from "../hooks/usePreviewPanelInlineSize";

/** The width key of the workstream last shown in the right panel. */
const LAST_SHOWN_KEY = "t3code:loom:right-panel-width:last-shown-key";

/** Upstream's per-thread key, taken at the workstream root: a root keeps the width it had. */
export const rightPanelWidthKey = (thread: ScopedThreadRef, rootThreadId: ThreadId) =>
  `t3code:preview-panel-width:${scopedThreadKey(scopeThreadRef(thread.environmentId, rootThreadId))}`;

const read = <T, E>(key: string | null, schema: Schema.Codec<T, E>): T | null => {
  try {
    return key === null ? null : getLocalStorageItem(key, schema);
  } catch {
    return null;
  }
};

/** The width `storageKey` opens at: its own, else the last workstream's, else upstream's default. */
const openingWidth = (storageKey: string) =>
  read(storageKey, Schema.Finite) ??
  read(read(LAST_SHOWN_KEY, Schema.String), Schema.Finite) ??
  PREVIEW_PANEL_DEFAULT_WIDTH;

/** Once shown, a workstream keeps the width it opened at, whatever is sized elsewhere later. */
export function useCarriedPanelWidth(storageKey: string): number {
  const width = openingWidth(storageKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the shown width in localStorage after the render that read it
  useLayoutEffect(() => {
    try {
      if (read(storageKey, Schema.Finite) === null)
        setLocalStorageItem(storageKey, width, Schema.Finite);
      setLocalStorageItem(LAST_SHOWN_KEY, storageKey, Schema.String);
    } catch (error) {
      console.error("Could not persist panel width.", error);
    }
  }, [storageKey, width]);
  return width;
}
