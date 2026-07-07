import { create } from "zustand";

/**
 * A one-shot request to scroll a thread's conversation timeline to the turn
 * dispatched at-or-before `anchorAtIso`. Set when a Workstream graph orchestrator
 * (bridge) node is clicked; survives the navigation + message load and is
 * consumed once by `MessagesTimeline` on arrival. Ephemeral — never persisted.
 */
export interface ScrollToDispatchRequest {
  threadId: string;
  anchorAtIso: string;
}

/**
 * A one-shot request to reveal (open + expand) the consult card(s) in an asker's
 * chat that consulted `targetThreadId`. Set alongside a `ScrollToDispatchRequest`
 * when a Workstream consult edge is clicked; consumed once by the matching
 * `ConsultCard`, which latches its own expanded state and clears this. Ephemeral.
 */
export interface ConsultRevealRequest {
  threadId: string;
  targetThreadId: string;
}

interface LoomScrollStore {
  scrollRequest: ScrollToDispatchRequest | null;
  consultReveal: ConsultRevealRequest | null;
  requestScrollToDispatch: (
    threadId: string,
    anchorAtIso: string,
    expandConsultTargetId?: string,
  ) => void;
  clearScrollRequest: () => void;
  clearConsultReveal: () => void;
}

export const useLoomScrollStore = create<LoomScrollStore>((set) => ({
  scrollRequest: null,
  consultReveal: null,
  requestScrollToDispatch: (threadId, anchorAtIso, expandConsultTargetId) =>
    set({
      scrollRequest: { threadId, anchorAtIso },
      consultReveal: expandConsultTargetId
        ? { threadId, targetThreadId: expandConsultTargetId }
        : null,
    }),
  clearScrollRequest: () => set((state) => (state.scrollRequest ? { scrollRequest: null } : state)),
  clearConsultReveal: () => set((state) => (state.consultReveal ? { consultReveal: null } : state)),
}));
