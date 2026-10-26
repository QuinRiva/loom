/** loom: client state for the hub login reminder; tiers per docs/architecture/loom-ui-state-tiers.md. */
import type { LoginAlert } from "@t3tools/shared/usageLimits";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

interface HubLoginState {
  /** Tier 2, persisted per browser by design: when each account's banner may show again (08:00). */
  snoozedUntil: Readonly<Record<string, number>>;
  /** Tier 3: the account the one mounted `HubLoginDialogHost` is open for, outliving its opener. */
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
