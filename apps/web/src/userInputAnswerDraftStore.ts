/**
 * In-progress answers to open agent questions, keyed by `(environmentId, requestId)`.
 *
 * Module-scoped rather than `ChatView` component state (client audit S7): a route
 * change remounts the chat view, so a partially answered multi-question request
 * used to be discarded by switching threads or tabs. Mobile already worked this
 * way — this is that model, plus the eviction neither client had: an entry is
 * deleted when its request resolves, so the maps do not grow for the session's
 * lifetime and a re-issued requestId can never inherit a stale draft.
 *
 * The transitions themselves live in `@t3tools/shared/userInputAnswers` and are
 * shared with mobile; this file is only the zustand binding. Two hand-written
 * copies of the eviction rule is exactly how mobile ended up deleting another
 * thread's draft on a thread switch while web did not.
 *
 * Deliberately NOT persisted: a question that outlives a reload is loud on every
 * other surface, and losing an unsubmitted partial selection there is accepted.
 * The requestId key means a stale draft could never attach to a new question
 * anyway.
 */
import type { UserInputQuestion } from "@t3tools/contracts";
import type {
  UserInputAnswerDraft,
  UserInputAnswerDraftEntries,
  UserInputAnswerDraftTarget,
} from "@t3tools/shared/userInputAnswers";
import {
  userInputAnswerDraftsOf,
  withResolvedUserInputDraftsEvicted,
  withToggledUserInputOption,
  withUserInputCustomAnswer,
} from "@t3tools/shared/userInputAnswers";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

export {
  userInputAnswerDraftKey,
  userInputAnswerDraftThreadKey,
} from "@t3tools/shared/userInputAnswers";

interface UserInputAnswerDraftStore {
  readonly entriesByRequestKey: UserInputAnswerDraftEntries;
  readonly toggleOption: (
    input: UserInputAnswerDraftTarget & {
      readonly question: UserInputQuestion;
      readonly optionLabel: string;
    },
  ) => void;
  readonly setCustomAnswer: (
    input: UserInputAnswerDraftTarget & {
      readonly questionId: string;
      readonly customAnswer: string;
    },
  ) => void;
  /** Drop this thread's resolved requests' drafts; other threads are untouched. */
  readonly evictResolvedRequests: (input: {
    readonly threadKey: string;
    readonly openRequestKeys: ReadonlySet<string>;
  }) => void;
}

export const useUserInputAnswerDraftStore = create<UserInputAnswerDraftStore>((set) => ({
  entriesByRequestKey: {},

  toggleOption: (input) => {
    set((state) => ({
      entriesByRequestKey: withToggledUserInputOption(state.entriesByRequestKey, input),
    }));
  },

  setCustomAnswer: (input) => {
    set((state) => ({
      entriesByRequestKey: withUserInputCustomAnswer(state.entriesByRequestKey, input),
    }));
  },

  evictResolvedRequests: (input) => {
    set((state) => {
      const next = withResolvedUserInputDraftsEvicted(state.entriesByRequestKey, input);
      return next === state.entriesByRequestKey ? state : { entriesByRequestKey: next };
    });
  },
}));

export const useUserInputAnswerDrafts = (
  requestKey: string | null,
): Record<string, UserInputAnswerDraft> =>
  useUserInputAnswerDraftStore(
    useShallow((state) => userInputAnswerDraftsOf(state.entriesByRequestKey, requestKey)),
  );
