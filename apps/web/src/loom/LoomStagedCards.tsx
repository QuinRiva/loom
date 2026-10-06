/**
 * loom: 3d-4 (DT-31) — the staged cards over an empty conversation. A held
 * thread (`workstream.held`: a `goal_continue` successor or a `thread_fork`
 * root) gets the kickoff offer; a Loom child with a brief on disk and no first
 * run yet gets the read-only preview. Both vanish once the conversation starts
 * (as rendered: optimistic message and in-flight send included) or the human
 * types. ChatView owns the send: Launch goes through its ordinary composer path.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";

import { StagedBriefPreviewCard } from "../components/chat/StagedBriefPreviewCard";
import { StagedKickoffCard } from "../components/chat/StagedKickoffCard";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadShell } from "../state/entities";

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
