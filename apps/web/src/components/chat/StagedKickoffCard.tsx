import { memo } from "react";
import { PencilIcon, RocketIcon } from "lucide-react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { StagedCard } from "./StagedCard";

/**
 * Whether the staged-kickoff card should be offered for a thread. Derived
 * purely from server state (a parent-less handoff root carrying a stored brief
 * that has not been launched) plus the persisted composer draft — so the offer
 * survives reloads and disappears the moment the human takes over (Edit first
 * seeds the draft; typing/sending seeds the draft or a message). No in-memory
 * "already seeded" flag, which is what broke this across reloads previously.
 */
export function shouldShowStagedKickoff(input: {
  parentThreadId: string | null;
  brief: string | null;
  messageCount: number;
  composerDraftPrompt: string;
}): boolean {
  return (
    input.parentThreadId === null &&
    (input.brief?.trim().length ?? 0) > 0 &&
    input.messageCount === 0 &&
    input.composerDraftPrompt.trim().length === 0
  );
}

interface StagedKickoffCardProps {
  readonly brief: string;
  readonly markdownCwd?: string | undefined;
  readonly launchDisabled?: boolean;
  /** Space to reserve at the bottom so the card clears the composer overlay. */
  readonly bottomInset?: number;
  readonly onLaunch: () => void;
  readonly onEditFirst: () => void;
}

/**
 * The empty-conversation offer shown for a not-yet-launched handoff root: the
 * kickoff brief rendered as markdown, with Launch (send it as the first message
 * through the normal composer path) and Edit first (drop it into the composer as
 * a draft) actions.
 */
export const StagedKickoffCard = memo(function StagedKickoffCard({
  brief,
  markdownCwd,
  launchDisabled,
  bottomInset,
  onLaunch,
  onEditFirst,
}: StagedKickoffCardProps) {
  return (
    <StagedCard
      badgeLabel="Staged"
      title="Staged kickoff"
      bottomInset={bottomInset}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onEditFirst}>
            <PencilIcon />
            Edit first
          </Button>
          <Button size="sm" onClick={onLaunch} disabled={launchDisabled}>
            <RocketIcon />
            Launch
          </Button>
        </>
      }
    >
      <ChatMarkdown text={brief} cwd={markdownCwd} />
    </StagedCard>
  );
});
