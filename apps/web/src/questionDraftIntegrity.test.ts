import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ApprovalRequestId,
  EnvironmentId,
  ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { buildUserInputAnswers } from "@t3tools/shared/userInputAnswers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "./composerDraftStore";
import {
  useUserInputAnswerDraftStore,
  userInputAnswerDraftKey,
  userInputAnswerDraftThreadKey,
} from "./userInputAnswerDraftStore";

/**
 * The client audit's S3 scenario, automated: an in-progress message draft and an
 * agent question coexist, and answering the question cannot touch the draft.
 *
 * Under the takeover, answering wrote through the *same* surface as the draft —
 * the editor value and `promptRef` — so an option click set `promptRef` to `""`
 * and a typed custom answer left it holding the answer text, with no guaranteed
 * restore. What `onSend` then transmitted depended on React re-render ordering.
 *
 * The two stores below are the structural fix: the message draft and the answer
 * draft are separate keyed records that share no writer. This test asserts the
 * separation across the whole question lifecycle — draft typed first, question
 * opened, answered, resolved — which is the property the card exists to deliver.
 */
const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-question-coexistence");
const threadRef = scopeThreadRef(environmentId, threadId);
const requestId = ApprovalRequestId.make("req-coexistence");
const requestKey = userInputAnswerDraftKey(environmentId, requestId);
const threadKey = userInputAnswerDraftThreadKey(environmentId, threadId);

const question: UserInputQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    { label: "Orchestration-first", description: "Orchestration" },
    { label: "Client-first", description: "Clients" },
  ],
  multiSelect: false,
};

const DRAFT = "the message I was halfway through typing";

const composerDraft = () => useComposerDraftStore.getState().getComposerDraft(threadRef);
const answerDrafts = () =>
  useUserInputAnswerDraftStore.getState().entriesByRequestKey[requestKey]?.answersByQuestionId ??
  {};

describe("a question and a message draft coexist (S3)", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useUserInputAnswerDraftStore.setState({ entriesByRequestKey: {} });
    useComposerDraftStore.getState().setPrompt(threadRef, DRAFT);
  });

  it("leaves the message draft untouched while an answer is selected and typed", () => {
    useUserInputAnswerDraftStore
      .getState()
      .toggleOption({ requestKey, threadKey, question, optionLabel: "Orchestration-first" });
    expect(composerDraft()?.prompt).toBe(DRAFT);

    useUserInputAnswerDraftStore.getState().setCustomAnswer({
      requestKey,
      threadKey,
      questionId: question.id,
      customAnswer: "neither, do it differently",
    });
    expect(composerDraft()?.prompt).toBe(DRAFT);
    expect(buildUserInputAnswers([question], answerDrafts())).toEqual({
      scope: "neither, do it differently",
    });
  });

  it("leaves the message draft untouched when the question resolves and its answer draft is evicted", () => {
    useUserInputAnswerDraftStore
      .getState()
      .toggleOption({ requestKey, threadKey, question, optionLabel: "Client-first" });

    useUserInputAnswerDraftStore
      .getState()
      .evictResolvedRequests({ threadKey, openRequestKeys: new Set<string>() });

    expect(answerDrafts()).toEqual({});
    expect(composerDraft()?.prompt).toBe(DRAFT);
  });

  it("leaves the answer draft untouched while the message draft is edited", () => {
    useUserInputAnswerDraftStore
      .getState()
      .toggleOption({ requestKey, threadKey, question, optionLabel: "Orchestration-first" });

    useComposerDraftStore.getState().setPrompt(threadRef, `${DRAFT} — and one more thing`);

    expect(answerDrafts().scope?.selectedOptionLabels).toEqual(["Orchestration-first"]);
  });
});
