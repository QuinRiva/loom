/**
 * loom: the staged cards over an empty conversation: a held thread (`workstream.held`) gets the
 * kickoff offer, a Loom child with a brief on disk and no first run the read-only preview, a query
 * thread the waiting row while its fork is deferred. They vanish once the conversation starts as
 * rendered or the human types. ChatView owns the send: Launch goes through its composer path.
 */
import { DOCUMENT_QUERY_ROLE, type ScopedThreadRef } from "@t3tools/contracts";

import { StagedBriefPreviewCard } from "../components/chat/StagedBriefPreviewCard";
import { StagedKickoffCard } from "../components/chat/StagedKickoffCard";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadShell } from "../state/entities";
import { DocumentQueryWaitingRow, isDocumentQueryWaiting } from "./DocumentQueryHeader";

export function LoomStagedCards({
  threadRef,
  composerDraftTarget,
  hasStarted,
  markdownCwd,
  launchDisabled,
  launchBlockedReason,
  bottomInset,
  onLaunch,
  onEditFirst,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly hasStarted: boolean;
  readonly markdownCwd: string | undefined;
  readonly launchDisabled: boolean;
  readonly launchBlockedReason: string | null;
  readonly bottomInset: number;
  readonly onLaunch: (brief: string) => void;
  readonly onEditFirst: (brief: string) => void;
}) {
  const workstream = useThreadShell(threadRef)?.source.workstream;
  const typing = useComposerDraftStore(
    (store) => (store.getComposerDraft(composerDraftTarget)?.prompt.trim().length ?? 0) > 0,
  );
  const briefPath = workstream?.kickoffBriefPath ?? null;
  // A query thread's brief is the server's deferred-launch record, not a brief
  // to preview: it shows only that the fork waits on its author.
  if (workstream?.role === DOCUMENT_QUERY_ROLE)
    return isDocumentQueryWaiting(workstream) && !hasStarted ? <DocumentQueryWaitingRow /> : null;
  if (briefPath === null || hasStarted || typing) return null;
  if (workstream?.held) {
    return (
      <StagedKickoffCard
        environmentId={threadRef.environmentId}
        kickoffBriefPath={briefPath}
        markdownCwd={markdownCwd}
        launchDisabled={launchDisabled}
        launchBlockedReason={launchBlockedReason}
        bottomInset={bottomInset}
        onLaunch={onLaunch}
        onEditFirst={onEditFirst}
      />
    );
  }
  return workstream?.kickoffAt === null && workstream.outcome === null ? (
    <StagedBriefPreviewCard
      environmentId={threadRef.environmentId}
      kickoffBriefPath={briefPath}
      markdownCwd={markdownCwd}
      bottomInset={bottomInset}
    />
  ) : null;
}
