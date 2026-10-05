import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * A one-shot request to scroll a thread's conversation timeline to the turn
 * running at-or-before `anchorAtIso`. Set when a Workstream surface asks "show
 * me where this happened" (a sub-thread's dispatch, a wave bridge, a consult,
 * a lifecycle transition); survives the navigation + message load and is
 * consumed once by `MessagesTimeline` on arrival. Ephemeral — never persisted.
 */
export interface ScrollToDispatchRequest {
  readonly threadId: ThreadId;
  readonly anchorAtIso: string;
}

interface LoomScrollStore {
  scrollRequest: ScrollToDispatchRequest | null;
  requestScrollToDispatch: (threadId: ThreadId, anchorAtIso: string) => void;
  clearScrollRequest: () => void;
}

export const useLoomScrollStore = create<LoomScrollStore>((set) => ({
  scrollRequest: null,
  requestScrollToDispatch: (threadId, anchorAtIso) =>
    set({ scrollRequest: { threadId, anchorAtIso } }),
  clearScrollRequest: () => set((state) => (state.scrollRequest ? { scrollRequest: null } : state)),
}));
