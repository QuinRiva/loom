/**
 * loom: the goal rename form as an imperative promise, because native context menus invoke it from
 * plain async handlers; the form itself is a dialog mounted once (`GoalFormDialogHost`). Tier-1,
 * never persisted; a second request supersedes the first, resolving it null.
 */
import { create } from "zustand";

export interface GoalFormValues {
  readonly title: string;
  readonly description: string;
}

interface GoalFormDialogState {
  readonly request: {
    readonly id: number;
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
let nextRequestId = 0;
export const promptGoalForm = (initial: GoalFormValues): Promise<GoalFormValues | null> =>
  new Promise((resolve) => {
    useGoalFormDialogStore.getState().request?.resolve(null);
    useGoalFormDialogStore.setState({ request: { id: ++nextRequestId, initial, resolve } });
  });
