import {
  ApprovalRequestId,
  EnvironmentId,
  ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { buildUserInputAnswers } from "@t3tools/shared/userInputAnswers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  useUserInputAnswerDraftStore,
  userInputAnswerDraftKey,
  userInputAnswerDraftThreadKey,
} from "./userInputAnswerDraftStore";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const requestId = ApprovalRequestId.make("req-1");
const otherRequestId = ApprovalRequestId.make("req-2");

const threadKey = userInputAnswerDraftThreadKey(environmentId, threadId);
const otherThreadKey = userInputAnswerDraftThreadKey(environmentId, otherThreadId);
const requestKey = userInputAnswerDraftKey(environmentId, requestId);
const otherRequestKey = userInputAnswerDraftKey(environmentId, otherRequestId);

const multiSelect: UserInputQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    { label: "Server", description: "Server" },
    { label: "Web", description: "Web" },
  ],
  multiSelect: true,
};

const singleSelect: UserInputQuestion = {
  id: "scope",
  header: "Scope",
  question: "What first?",
  options: [{ label: "Orchestration-first", description: "Orchestration" }],
  multiSelect: false,
};

const store = () => useUserInputAnswerDraftStore.getState();
const answersFor = (key: string) => store().entriesByRequestKey[key]?.answersByQuestionId ?? {};

describe("user input answer drafts", () => {
  beforeEach(() => {
    useUserInputAnswerDraftStore.setState({ entriesByRequestKey: {} });
  });

  it("accumulates a multi-select answer across clicks and carries every label to the wire payload", () => {
    store().toggleOption({ requestKey, threadKey, question: multiSelect, optionLabel: "Server" });
    store().toggleOption({ requestKey, threadKey, question: multiSelect, optionLabel: "Web" });

    expect(buildUserInputAnswers([multiSelect], answersFor(requestKey))).toEqual({
      areas: ["Server", "Web"],
    });
  });

  it("survives the component lifetime, so a partial answer outlives a thread switch (S7)", () => {
    store().toggleOption({ requestKey, threadKey, question: multiSelect, optionLabel: "Server" });
    store().setCustomAnswer({
      requestKey,
      threadKey,
      questionId: singleSelect.id,
      customAnswer: "half typed",
    });

    // Nothing about a route change touches a module-scoped store: the state is
    // read back verbatim, which is the whole point of moving it out of ChatView.
    expect(answersFor(requestKey).scope?.customAnswer).toBe("half typed");
    expect(answersFor(requestKey).areas?.selectedOptionLabels).toEqual(["Server"]);
  });

  it("evicts a request's draft once it resolves, by any outcome", () => {
    store().toggleOption({ requestKey, threadKey, question: multiSelect, optionLabel: "Server" });
    store().toggleOption({
      requestKey: otherRequestKey,
      threadKey,
      question: singleSelect,
      optionLabel: "Orchestration-first",
    });

    store().evictResolvedRequests({ threadKey, openRequestKeys: new Set([otherRequestKey]) });

    expect(answersFor(requestKey)).toEqual({});
    expect(answersFor(otherRequestKey).scope?.selectedOptionLabels).toEqual([
      "Orchestration-first",
    ]);
  });

  it("never evicts another thread's in-progress answer", () => {
    store().toggleOption({ requestKey, threadKey, question: multiSelect, optionLabel: "Server" });

    // A different thread reporting its (empty) open set must not be able to
    // discard this thread's partially typed answer.
    store().evictResolvedRequests({
      threadKey: otherThreadKey,
      openRequestKeys: new Set<string>(),
    });

    expect(answersFor(requestKey).areas?.selectedOptionLabels).toEqual(["Server"]);
  });

  it("does not rewrite state when there is nothing to evict", () => {
    store().toggleOption({ requestKey, threadKey, question: multiSelect, optionLabel: "Server" });
    const before = store().entriesByRequestKey;

    store().evictResolvedRequests({ threadKey, openRequestKeys: new Set([requestKey]) });

    expect(store().entriesByRequestKey).toBe(before);
  });
});
