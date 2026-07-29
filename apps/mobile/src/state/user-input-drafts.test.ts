import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  EnvironmentId,
  ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";

import {
  buildUserInputAnswers,
  userInputAnswerDraftKey,
  userInputAnswerDraftsOf,
  userInputAnswerDraftThreadKey,
  withResolvedUserInputDraftsEvicted,
  withToggledUserInputOption,
} from "@t3tools/shared/userInputAnswers";

import { appAtomRegistry } from "./atom-registry";
import { userInputDraftsAtom } from "./user-input-drafts";

/**
 * Mobile's answer-draft atom, exercised the way the hook drives it.
 *
 * The atom is `keepAlive` precisely so a partial answer outlives a thread switch,
 * and it previously undid that itself: eviction matched an ENVIRONMENT prefix
 * against the selected thread's open set, so selecting any other thread in the
 * same environment deleted the draft the user was part-way through. These cover
 * the atom-level behaviour; the rule itself is pinned in
 * `packages/shared/src/userInputAnswers.test.ts`.
 */
const environmentId = EnvironmentId.make("env-1");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const requestA = ApprovalRequestId.make("req-a");
const requestB = ApprovalRequestId.make("req-b");

const threadKeyA = userInputAnswerDraftThreadKey(environmentId, threadA);
const threadKeyB = userInputAnswerDraftThreadKey(environmentId, threadB);
const requestKeyA = userInputAnswerDraftKey(environmentId, requestA);
const requestKeyB = userInputAnswerDraftKey(environmentId, requestB);

const multiSelect: UserInputQuestion = {
  id: "surfaces",
  header: "Surfaces",
  question: "Which surfaces should the change cover?",
  options: [
    { label: "Server", description: "Server" },
    { label: "Web", description: "Web" },
    { label: "Mobile", description: "Mobile" },
  ],
  multiSelect: true,
};

/** The hook's option-select path. */
const selectOption = (
  requestKey: string,
  threadKey: string,
  question: UserInputQuestion,
  optionLabel: string,
): void => {
  appAtomRegistry.set(
    userInputDraftsAtom,
    withToggledUserInputOption(appAtomRegistry.get(userInputDraftsAtom), {
      requestKey,
      threadKey,
      question,
      optionLabel,
    }),
  );
};

/** The hook's eviction effect, which fires for whichever thread is selected. */
const selectThread = (threadKey: string, openRequestKeys: ReadonlyArray<string>): void => {
  appAtomRegistry.set(
    userInputDraftsAtom,
    withResolvedUserInputDraftsEvicted(appAtomRegistry.get(userInputDraftsAtom), {
      threadKey,
      openRequestKeys: new Set(openRequestKeys),
    }),
  );
};

const draftsFor = (requestKey: string) =>
  userInputAnswerDraftsOf(appAtomRegistry.get(userInputDraftsAtom), requestKey);

afterEach(() => {
  appAtomRegistry.set(userInputDraftsAtom, {});
});

describe("mobile user-input answer drafts", () => {
  it("accumulates a multi-select answer and carries every label to the wire payload", () => {
    selectOption(requestKeyA, threadKeyA, multiSelect, "Server");
    selectOption(requestKeyA, threadKeyA, multiSelect, "Web");

    expect(buildUserInputAnswers([multiSelect], draftsFor(requestKeyA))).toEqual({
      surfaces: ["Server", "Web"],
    });
  });

  it("keeps thread B's partial answer when thread A is selected", () => {
    selectOption(requestKeyB, threadKeyB, multiSelect, "Mobile");

    // Thread A becomes the selected thread and reports its own open set. Under the
    // old environment-prefix eviction this single step destroyed B's answer.
    selectThread(threadKeyA, []);

    expect(draftsFor(requestKeyB).surfaces?.selectedOptionLabels).toEqual(["Mobile"]);
  });

  it("keeps thread B's partial answer when thread A's own question resolves", () => {
    selectOption(requestKeyA, threadKeyA, multiSelect, "Server");
    selectOption(requestKeyB, threadKeyB, multiSelect, "Mobile");

    // A's request resolves while A is on screen: A's draft goes, B's stays.
    selectThread(threadKeyA, []);

    expect(draftsFor(requestKeyA)).toEqual({});
    expect(draftsFor(requestKeyB).surfaces?.selectedOptionLabels).toEqual(["Mobile"]);
  });

  it("evicts on a startup-scan cancellation, since eviction reads the open set and not the outcome", () => {
    selectOption(requestKeyB, threadKeyB, multiSelect, "Mobile");

    // A boot-time `resolved{cancelled}` drops the request from the derived open
    // set exactly as an answer or dismissal would.
    selectThread(threadKeyB, []);

    expect(draftsFor(requestKeyB)).toEqual({});
  });

  it("survives a round trip away from and back to the answering thread", () => {
    selectOption(requestKeyB, threadKeyB, multiSelect, "Mobile");
    selectThread(threadKeyA, []);
    selectThread(threadKeyB, [requestKeyB]);

    expect(draftsFor(requestKeyB).surfaces?.selectedOptionLabels).toEqual(["Mobile"]);
  });
});
