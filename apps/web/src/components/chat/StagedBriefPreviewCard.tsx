import { memo } from "react";
import { FileTextIcon } from "lucide-react";

import type { EnvironmentId } from "@t3tools/contracts";
import ChatMarkdown from "../ChatMarkdown";
import { useProjectAbsoluteFileQuery } from "../files/projectFilesQueryState";
import { StagedCard } from "./StagedCard";

/**
 * Whether the read-only brief-preview card should be shown for a thread. A
 * scaffolded/planned child stores its kickoff brief on disk (`kickoffBriefPath`)
 * rather than carrying it inline as the `brief` string the way a handoff root
 * does, so `StagedKickoffCard` never fires for it and the brief is invisible
 * until launch. This surfaces that brief for human review while the node is
 * still parked (planned or awaiting-launch), which is the whole point of holding
 * a node as `planned`. It disappears the moment the conversation starts or the
 * human begins typing in the composer.
 *
 * As with the staged-kickoff offer, `hasStarted` must reflect the conversation as
 * RENDERED (optimistic message and in-flight send included) rather than durable
 * server state, or this overlay flashes back over a launching conversation. See
 * `stagedOverlayConversationStarted`.
 */
export function shouldShowStagedBriefPreview(input: {
  kickoffBriefPath: string | null;
  hasStarted: boolean;
  composerDraftPrompt: string;
}): boolean {
  return (
    input.kickoffBriefPath !== null &&
    !input.hasStarted &&
    input.composerDraftPrompt.trim().length === 0
  );
}

interface StagedBriefPreviewCardProps {
  readonly environmentId: EnvironmentId;
  readonly kickoffBriefPath: string;
  readonly markdownCwd?: string | undefined;
  /** Space to reserve at the bottom so the card clears the composer overlay. */
  readonly bottomInset?: number;
}

/**
 * Read-only preview of a not-yet-launched child's kickoff brief, read from disk
 * by absolute path. Shares `StagedCard`'s shell but carries no Launch / Edit
 * actions: a scaffolded child launches automatically once its dependencies clear
 * and it holds a brief, and a `planned` node is released via its plan-lane
 * control — this surface exists purely so a human can read the brief first.
 */
export const StagedBriefPreviewCard = memo(function StagedBriefPreviewCard({
  environmentId,
  kickoffBriefPath,
  markdownCwd,
  bottomInset,
}: StagedBriefPreviewCardProps) {
  const { data, error, isPending } = useProjectAbsoluteFileQuery(environmentId, kickoffBriefPath);
  const brief = data?.contents ?? null;

  return (
    <StagedCard
      badgeLabel="Brief"
      badgeIcon={<FileTextIcon className="size-3" />}
      title="Kickoff brief"
      trailing={<span className="shrink-0 text-muted-foreground text-xs">Not launched yet</span>}
      bottomInset={bottomInset}
    >
      {brief !== null ? (
        <ChatMarkdown text={brief} cwd={markdownCwd} />
      ) : error !== null ? (
        <p className="text-destructive text-sm">Could not read the brief: {error}</p>
      ) : (
        <p className="text-muted-foreground text-sm">
          {isPending ? "Loading brief…" : "This brief is empty."}
        </p>
      )}
    </StagedCard>
  );
});
