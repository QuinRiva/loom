import type {
  ApprovalRequestId,
  EnvironmentId,
  ProviderUserInputAnswers,
  ThreadId,
  UserInputQuestion,
} from "@t3tools/contracts";

/**
 * The human's in-progress answer to one question of an open agent question, and
 * the rules for turning a set of them into the wire contract.
 *
 * Shared by web and mobile deliberately: mobile previously carried a singular
 * `selectedOptionLabel` and silently truncated a multi-select answer to one
 * label, which the `string | string[]` contract now makes a real correctness
 * bug. One definition means multi-select cannot be right on one client and wrong
 * on the other.
 *
 * @module userInputAnswers
 */

export interface UserInputAnswerDraft {
  readonly selectedOptionLabels?: ReadonlyArray<string>;
  /** Free text typed instead of choosing an option; wins over any selection. */
  readonly customAnswer?: string;
}

const trimmedOrNull = (value: string | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeSelectedOptionLabels = (
  value: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return [];
  const normalized = new Set<string>();
  for (const entry of value) {
    const trimmed = trimmedOrNull(entry);
    if (trimmed !== null) normalized.add(trimmed);
  }
  return [...normalized];
};

/** The wire answer for one question, or `null` while it is still unanswered. */
export const resolveUserInputAnswer = (
  question: UserInputQuestion,
  draft: UserInputAnswerDraft | undefined,
): string | ReadonlyArray<string> | null => {
  const customAnswer = trimmedOrNull(draft?.customAnswer);
  if (customAnswer !== null) return customAnswer;

  const selected = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  if (question.multiSelect) return selected.length > 0 ? selected : null;
  return selected[0] ?? null;
};

export const selectedUserInputOptionLabels = (
  draft: UserInputAnswerDraft | undefined,
): ReadonlyArray<string> => normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

/** Whether free text is in play, which overrides the option selection. */
export const isUsingCustomUserInputAnswer = (draft: UserInputAnswerDraft | undefined): boolean =>
  trimmedOrNull(draft?.customAnswer) !== null;

export const setUserInputCustomAnswer = (
  draft: UserInputAnswerDraft | undefined,
  customAnswer: string,
): UserInputAnswerDraft => {
  // Free text overrides the selection, so it is dropped rather than left to
  // reappear if the field is later emptied.
  const selectedOptionLabels =
    customAnswer.trim().length > 0
      ? []
      : normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  return {
    customAnswer,
    ...(selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
};

export const toggleUserInputOptionSelection = (
  question: UserInputQuestion,
  draft: UserInputAnswerDraft | undefined,
  optionLabel: string,
): UserInputAnswerDraft => {
  if (!question.multiSelect) {
    return { customAnswer: "", selectedOptionLabels: [optionLabel] };
  }

  const selected = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  const next = selected.includes(optionLabel)
    ? selected.filter((label) => label !== optionLabel)
    : [...selected, optionLabel];

  return {
    customAnswer: "",
    ...(next.length > 0 ? { selectedOptionLabels: next } : {}),
  };
};

/**
 * The complete answers payload, or `null` while any question is unanswered —
 * the submit control's enablement is exactly this being non-null.
 */
export const buildUserInputAnswers = (
  questions: ReadonlyArray<UserInputQuestion>,
  drafts: Record<string, UserInputAnswerDraft>,
): ProviderUserInputAnswers | null => {
  const answers: Record<string, string | ReadonlyArray<string>> = {};

  for (const question of questions) {
    const answer = resolveUserInputAnswer(question, drafts[question.id]);
    if (answer === null) return null;
    answers[question.id] = answer;
  }

  return answers;
};

export const countAnsweredUserInputQuestions = (
  questions: ReadonlyArray<UserInputQuestion>,
  drafts: Record<string, UserInputAnswerDraft>,
): number =>
  questions.reduce(
    (count, question) =>
      resolveUserInputAnswer(question, drafts[question.id]) !== null ? count + 1 : count,
    0,
  );

// ---------------------------------------------------------------------------
// The draft collection: one entry per open request, and the transitions over it
// ---------------------------------------------------------------------------

/**
 * One request's in-progress answers, tagged with the thread that owns it.
 *
 * The `threadKey` exists solely so eviction can tell whose request it is judging.
 * A client only ever knows the open set of the thread it is currently showing, so
 * without this tag "not in the open set" is indistinguishable from "belongs to a
 * thread I am not looking at" — and a routine thread switch silently deletes the
 * other thread's partially typed answer.
 */
export interface UserInputAnswerDraftEntry {
  readonly threadKey: string;
  readonly answersByQuestionId: Record<string, UserInputAnswerDraft>;
}

/** Every open request's drafts, keyed by `(environmentId, requestId)`. */
export type UserInputAnswerDraftEntries = Record<string, UserInputAnswerDraftEntry>;

export interface UserInputAnswerDraftTarget {
  /** `(environmentId, requestId)` — unique per request, so a re-issue cannot inherit a draft. */
  readonly requestKey: string;
  /** `(environmentId, threadId)` of the thread the request belongs to. */
  readonly threadKey: string;
}

const NO_DRAFTS: Record<string, UserInputAnswerDraft> = {};

export const userInputAnswerDraftKey = (
  environmentId: EnvironmentId,
  requestId: ApprovalRequestId,
): string => `${environmentId}:${requestId}`;

export const userInputAnswerDraftThreadKey = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string => `${environmentId}:${threadId}`;

export const userInputAnswerDraftsOf = (
  entries: UserInputAnswerDraftEntries,
  requestKey: string | null,
): Record<string, UserInputAnswerDraft> =>
  requestKey === null ? NO_DRAFTS : (entries[requestKey]?.answersByQuestionId ?? NO_DRAFTS);

const withAnswers = (
  entries: UserInputAnswerDraftEntries,
  { requestKey, threadKey }: UserInputAnswerDraftTarget,
  answersByQuestionId: Record<string, UserInputAnswerDraft>,
): UserInputAnswerDraftEntries => ({
  ...entries,
  [requestKey]: { threadKey, answersByQuestionId },
});

export const withToggledUserInputOption = (
  entries: UserInputAnswerDraftEntries,
  target: UserInputAnswerDraftTarget & {
    readonly question: UserInputQuestion;
    readonly optionLabel: string;
  },
): UserInputAnswerDraftEntries => {
  const answers = userInputAnswerDraftsOf(entries, target.requestKey);
  return withAnswers(entries, target, {
    ...answers,
    [target.question.id]: toggleUserInputOptionSelection(
      target.question,
      answers[target.question.id],
      target.optionLabel,
    ),
  });
};

export const withUserInputCustomAnswer = (
  entries: UserInputAnswerDraftEntries,
  target: UserInputAnswerDraftTarget & {
    readonly questionId: string;
    readonly customAnswer: string;
  },
): UserInputAnswerDraftEntries => {
  const answers = userInputAnswerDraftsOf(entries, target.requestKey);
  return withAnswers(entries, target, {
    ...answers,
    [target.questionId]: setUserInputCustomAnswer(answers[target.questionId], target.customAnswer),
  });
};

/**
 * Drop the drafts of ONE thread's requests that are no longer open — by any
 * resolution outcome, including the startup scan's `cancelled`, since the rule
 * reads the open set and never the outcome.
 *
 * Entries belonging to other threads are untouched: the caller's `openRequestKeys`
 * describes `threadKey` only, and treating it as authoritative for the whole store
 * is what makes a thread switch destructive. Returns the same reference when
 * nothing is stale, so a subscriber does not re-render on a no-op.
 */
export const withResolvedUserInputDraftsEvicted = (
  entries: UserInputAnswerDraftEntries,
  input: { readonly threadKey: string; readonly openRequestKeys: ReadonlySet<string> },
): UserInputAnswerDraftEntries => {
  const staleKeys = Object.keys(entries).filter(
    (requestKey) =>
      entries[requestKey]?.threadKey === input.threadKey && !input.openRequestKeys.has(requestKey),
  );
  if (staleKeys.length === 0) {
    return entries;
  }
  const next = { ...entries };
  for (const requestKey of staleKeys) {
    delete next[requestKey];
  }
  return next;
};
