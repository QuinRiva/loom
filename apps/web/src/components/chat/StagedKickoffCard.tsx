import { memo } from "react";
import { PencilIcon, RocketIcon } from "lucide-react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { StagedCard } from "./StagedCard";

/**
 * Whether the staged-kickoff card should be offered for a thread: a parent-less
 * handoff root carrying a stored brief whose conversation has not begun, and
 * whose composer the human has not taken over (Edit first seeds the draft, as
 * does typing). Keying off the persisted draft rather than an in-memory
 * "already seeded" flag is what makes the offer survive reloads.
 *
 * `hasStarted` must reflect the conversation as RENDERED — including the
 * optimistic user message and the in-flight send — not just durable server
 * state. This card is an overlay drawn in front of the timeline, so a
 * server-only test would let it reappear over the launching conversation for
 * the whole turn-start round-trip. See `stagedOverlayConversationStarted`.
 */
export function shouldShowStagedKickoff(input: {
  parentThreadId: string | null;
  brief: string | null;
  hasStarted: boolean;
  composerDraftPrompt: string;
}): boolean {
  return (
    input.parentThreadId === null &&
    (input.brief?.trim().length ?? 0) > 0 &&
    !input.hasStarted &&
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
