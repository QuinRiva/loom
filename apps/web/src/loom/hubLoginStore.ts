/**
 * loom: client state for the hub login reminder.
 *
 * - `snoozedUntil` (tier 2, client-local, persisted): per account email, when
 *   its composer banner may show again: 08:00 the next morning. Per browser by
 *   design; a hold that lasts until morning is not worth a wire change.
 * - `dialog` (tier 3, not persisted): the account the Log in… dialog is open
 *   for, set by the banner or the Usage page and read by the one mounted
 *   `HubLoginDialogHost`, so the dialog outlives the banner that opened it.
 *
 * See docs/architecture/loom-ui-state-tiers.md.
 */
import type { LoginAlert } from "@t3tools/shared/usageLimits";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

interface HubLoginState {
  snoozedUntil: Readonly<Record<string, number>>;
  dialog: LoginAlert | null;
  snooze: (email: string, until: number) => void;
  openDialog: (alert: LoginAlert | null) => void;
}

export const useHubLoginStore = create<HubLoginState>()(
  persist(
    (set) => ({
      snoozedUntil: {},
      dialog: null,
      snooze: (email, until) =>
        set((state) => ({
          // Lapsed snoozes are dropped on every write, so the map never grows.
          snoozedUntil: Object.fromEntries([
            ...Object.entries(state.snoozedUntil).filter(([, at]) => at > Date.now()),
            [email, until],
          ]),
        })),
      openDialog: (dialog) => set({ dialog }),
    }),
    {
      name: "t3code:loom-hub-login:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ snoozedUntil: state.snoozedUntil }),
    },
  ),
);

/** 08:00 local on the day after `now`. */
export function nextMorning(now: number): number {
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(8, 0, 0, 0);
  return morning.getTime();
}
