import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type UserInputQuestion,
} from "@t3tools/contracts";

import {
  buildUserInputAnswers,
  userInputAnswerDraftKey,
  userInputAnswerDraftsOf,
  userInputAnswerDraftThreadKey,
  withResolvedUserInputDraftsEvicted,
  withToggledUserInputOption,
  withUserInputCustomAnswer,
} from "@t3tools/shared/userInputAnswers";
import { threadEnvironment } from "../state/threads";
import { updateUserInputDrafts, userInputDraftsAtom } from "./user-input-drafts";
import { derivePendingApprovals, derivePendingUserInputs } from "../lib/threadActivity";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";

export function useSelectedThreadRequests() {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const dismissUserInput = useAtomCommand(
    threadEnvironment.dismissUserInput,
    "thread user input dismissal",
  );
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const userInputDrafts = useAtomValue(userInputDraftsAtom);
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  const [dismissingUserInputId, setDismissingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );

  const activePendingApprovals = useMemo(
    () => (selectedThread ? derivePendingApprovals(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;
  const activePendingUserInputs = useMemo(
    () => (selectedThread ? derivePendingUserInputs(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const selectedThreadKey = selectedThreadShell
    ? userInputAnswerDraftThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const activePendingUserInputRequestKey =
    activePendingUserInput && selectedThreadShell
      ? userInputAnswerDraftKey(selectedThreadShell.environmentId, activePendingUserInput.requestId)
      : null;
  const activePendingUserInputDrafts = userInputAnswerDraftsOf(
    userInputDrafts,
    activePendingUserInputRequestKey,
  );
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  // Eviction judges ONLY the selected thread's requests: its open set says nothing
  // about any other thread, so evicting beyond it would discard a draft the user is
  // still part-way through on a thread they merely navigated away from.
  useEffect(() => {
    if (!selectedThreadShell || selectedThreadKey === null) {
      return;
    }
    const openRequestKeys = new Set(
      activePendingUserInputs.map((pending) =>
        userInputAnswerDraftKey(selectedThreadShell.environmentId, pending.requestId),
      ),
    );
    updateUserInputDrafts((entries) =>
      withResolvedUserInputDraftsEvicted(entries, {
        threadKey: selectedThreadKey,
        openRequestKeys,
      }),
    );
  }, [activePendingUserInputs, selectedThreadKey, selectedThreadShell]);

  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, question: UserInputQuestion, label: string) => {
      if (!selectedThreadShell || selectedThreadKey === null) {
        return;
      }

      updateUserInputDrafts((entries) =>
        withToggledUserInputOption(entries, {
          requestKey: userInputAnswerDraftKey(selectedThreadShell.environmentId, requestId),
          threadKey: selectedThreadKey,
          question,
          optionLabel: label,
        }),
      );
    },
    [selectedThreadKey, selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) => {
      if (!selectedThreadShell || selectedThreadKey === null) {
        return;
      }

      updateUserInputDrafts((entries) =>
        withUserInputCustomAnswer(entries, {
          requestKey: userInputAnswerDraftKey(selectedThreadShell.environmentId, requestId),
          threadKey: selectedThreadKey,
          questionId,
          customAnswer,
        }),
      );
    },
    [selectedThreadKey, selectedThreadShell],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThreadShell) {
        return;
      }

      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
        },
      });
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [respondToApproval, selectedThreadShell],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (!selectedThreadShell || !activePendingUserInput || !activePendingUserInputAnswers) {
      return;
    }

    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await respondToUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
      },
    });
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    return result;
  }, [
    activePendingUserInput,
    activePendingUserInputAnswers,
    respondToUserInput,
    selectedThreadShell,
  ]);

  // The human's way out of an open question, with no provider round trip on the
  // critical path: settlement is server-side, so this works even when the asking
  // session is long dead.
  const onDismissUserInput = useCallback(async () => {
    if (!selectedThreadShell || !activePendingUserInput) {
      return;
    }

    setDismissingUserInputId(activePendingUserInput.requestId);
    const result = await dismissUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
      },
    });
    setDismissingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    return result;
  }, [activePendingUserInput, dismissUserInput, selectedThreadShell]);

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputCount: activePendingUserInputs.length,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingApprovalId,
    respondingUserInputId,
    dismissingUserInputId,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
    onDismissUserInput,
  };
}
