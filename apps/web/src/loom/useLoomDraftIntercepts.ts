/**
 * loom: the `/handoff` and `/retro` composer intercepts (3d-3). ChatView's
 * send authority calls the returned function first; `true` means the prompt
 * was a recognised draft command and was handled (dispatched, or refused with
 * an inline error) — it must never fall through to a turn on this thread.
 *
 * The calls go to 3b's `loom.handoffDraft` / `loom.retroDraft` with the
 * `HandoffDraft*` / `RetroDraft*` contract shapes. Until integration lands
 * 3b's handlers the server answers with a `LoomWsMethodError` naming the
 * method, which surfaces as the thread's inline error (DL-433).
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { waitForThreadShell } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  type ComposerContentSnapshot,
  decideHandoffSend,
  decideRetroSend,
  runComposerDraftIntercept,
} from "./composerIntercepts";
import { loomCommands } from "./loomGoalState";

export interface LoomDraftInterceptPorts {
  readonly source: ScopedThreadRef;
  readonly submittedPrompt: string;
  readonly trimmedPrompt: string;
  readonly hasAttachmentsOrContexts: boolean;
  readonly setSendInFlight: (inFlight: boolean) => void;
  readonly clearComposer: () => void;
  readonly readComposerContent: () => ComposerContentSnapshot;
  readonly restoreComposer: (prompt: string) => void;
  readonly setThreadError: (threadId: ThreadId, error: string | null) => void;
}

export function useLoomDraftIntercepts() {
  const handoffDraft = useAtomCommand(loomCommands.handoffDraft, { reportFailure: false });
  const retroDraft = useAtomCommand(loomCommands.retroDraft, { reportFailure: false });
  const navigate = useNavigate();

  return useCallback(
    async (ports: LoomDraftInterceptPorts): Promise<boolean> => {
      const { source, setThreadError } = ports;
      const decide = {
        trimmedPrompt: ports.trimmedPrompt,
        hasAttachmentsOrContexts: ports.hasAttachmentsOrContexts,
      };
      const handoff = decideHandoffSend(decide);
      const retro = handoff.kind === "not-handoff" ? decideRetroSend(decide) : null;
      if (handoff.kind === "not-handoff" && (retro === null || retro.kind === "not-retro"))
        return false;
      const refusal =
        handoff.kind === "empty-error" || handoff.kind === "blocked-context"
          ? handoff.message
          : retro?.kind === "blocked-context"
            ? retro.message
            : null;
      if (refusal !== null) {
        setThreadError(source.threadId, refusal);
        return true;
      }
      const run = <A, E>(
        dispatch: () => Promise<AtomCommandResult<A, E>>,
        failureMessage: string,
        onDispatched: (value: A) => void,
      ) =>
        runComposerDraftIntercept({
          submittedPrompt: ports.submittedPrompt,
          setSendInFlight: ports.setSendInFlight,
          clearComposer: ports.clearComposer,
          readComposerContent: ports.readComposerContent,
          restoreComposer: ports.restoreComposer,
          dispatch,
          onSuccess: (result) => {
            setThreadError(source.threadId, null);
            onDispatched(result.value);
          },
          onFailure: (result) => {
            const error = isAtomCommandInterrupted(result)
              ? null
              : squashAtomCommandFailure(result);
            setThreadError(
              source.threadId,
              error instanceof Error ? error.message : failureMessage,
            );
          },
        });
      if (handoff.kind === "dispatch") {
        await run(
          () =>
            handoffDraft({
              environmentId: source.environmentId,
              input: { sourceThreadId: source.threadId, explanation: handoff.explanation },
            }),
          "Could not hand off this work.",
          // The receipt row (`loomTimelineRows.ts`) reports progress from here on.
          () => {},
        );
      } else if (retro?.kind === "dispatch") {
        await run(
          () =>
            retroDraft({
              environmentId: source.environmentId,
              input: {
                sourceThreadId: source.threadId,
                ...(retro.focus !== undefined ? { focus: retro.focus } : {}),
              },
            }),
          "Could not start the retro.",
          // Navigating before the reviewer's shell reaches this client reads as a
          // missing thread and bounces to `/` (as upstream's fork action avoids).
          (result) => {
            const reviewer = scopeThreadRef(source.environmentId, result.reviewerThreadId);
            void waitForThreadShell(reviewer).then((ready) => {
              if (ready)
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(reviewer),
                });
            });
          },
        );
      }
      return true;
    },
    [handoffDraft, navigate, retroDraft],
  );
}
