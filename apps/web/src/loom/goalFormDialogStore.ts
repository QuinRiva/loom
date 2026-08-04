/**
 * loom: imperative, promise-shaped goal form.
 *
 * Goal create/rename are invoked from native context menus and overflow menus —
 * callers that are plain async handlers, not React trees. `window.prompt` used
 * to serve that (three prompts in a row for create); this store keeps the
 * imperative call shape while the rendered form is a real dialog, mounted once
 * at the app root (`GoalFormDialogHost`).
 *
 * Tier-1 ephemeral UI state: never persisted, one request at a time (a second
 * request supersedes the first, resolving it null).
 */
import { create } from "zustand";

export interface GoalFormValues {
  readonly title: string;
  readonly slug: string;
  readonly description: string;
}

export interface GoalFormRequest {
  readonly mode: "create" | "rename";
  readonly initial: GoalFormValues;
}

interface GoalFormDialogState {
  readonly request:
    | (GoalFormRequest & { readonly resolve: (v: GoalFormValues | null) => void })
    | null;
  readonly openGoalForm: (request: GoalFormRequest) => Promise<GoalFormValues | null>;
  readonly resolveGoalForm: (values: GoalFormValues | null) => void;
}

export const useGoalFormDialogStore = create<GoalFormDialogState>()((set, get) => ({
  request: null,
  openGoalForm: (request) =>
    new Promise<GoalFormValues | null>((resolve) => {
      get().request?.resolve(null);
      set({ request: { ...request, resolve } });
    }),
  resolveGoalForm: (values) => {
    const pending = get().request;
    if (!pending) return;
    set({ request: null });
    pending.resolve(values);
  },
}));

/** Imperative entry point for handlers outside the React tree. */
export const promptGoalForm = (request: GoalFormRequest): Promise<GoalFormValues | null> =>
  useGoalFormDialogStore.getState().openGoalForm(request);

/** Slug proposal shared by the dialog and its callers: lowercase, dash-joined. */
export function slugifyGoalTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
