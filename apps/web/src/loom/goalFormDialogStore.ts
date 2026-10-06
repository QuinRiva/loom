/**
 * loom: imperative, promise-shaped goal rename form (3d-3).
 *
 * Goal rename is invoked from native context menus — plain async handlers, not
 * React trees. This store keeps that imperative call shape while the rendered
 * form is a real dialog, mounted once (`GoalFormDialogHost`, in the sidebar).
 *
 * Tier-1 ephemeral UI state: never persisted, one request at a time (a second
 * request supersedes the first, resolving it null).
 */
import { create } from "zustand";

export interface GoalFormValues {
  readonly title: string;
  readonly description: string;
}

interface GoalFormDialogState {
  readonly request: {
    readonly initial: GoalFormValues;
    readonly resolve: (values: GoalFormValues | null) => void;
  } | null;
  readonly resolveGoalForm: (values: GoalFormValues | null) => void;
}

export const useGoalFormDialogStore = create<GoalFormDialogState>()((set, get) => ({
  request: null,
  resolveGoalForm: (values) => {
    const pending = get().request;
    if (!pending) return;
    set({ request: null });
    pending.resolve(values);
  },
}));

/** Imperative entry point for handlers outside the React tree. */
export const promptGoalForm = (initial: GoalFormValues): Promise<GoalFormValues | null> =>
  new Promise((resolve) => {
    useGoalFormDialogStore.getState().request?.resolve(null);
    useGoalFormDialogStore.setState({ request: { initial, resolve } });
  });
