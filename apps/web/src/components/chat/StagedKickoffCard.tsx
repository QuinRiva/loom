import { memo } from "react";
import { PencilIcon, RocketIcon } from "lucide-react";

import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

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
 * a draft) actions. Kept in its own module so ChatView needs only a small mount
 * point — the previous inline seeding effect died in an upstream ChatView
 * rewrite.
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
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center overflow-y-auto px-4 py-6 sm:py-10"
      style={bottomInset ? { paddingBottom: bottomInset + 24 } : undefined}
    >
      <div className="pointer-events-auto flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
        <header className="flex items-center gap-2 border-border/60 border-b px-4 py-3 sm:px-5">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold uppercase tracking-wide"
          >
            Staged
          </Badge>
          <span className="min-w-0 flex-1 truncate font-medium text-sm">Staged kickoff</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4">
          <ChatMarkdown text={brief} cwd={markdownCwd} />
        </div>
        <footer className="flex items-center justify-end gap-2 border-border/60 border-t px-4 py-3 sm:px-5">
          <Button variant="outline" size="sm" onClick={onEditFirst}>
            <PencilIcon />
            Edit first
          </Button>
          <Button size="sm" onClick={onLaunch} disabled={launchDisabled}>
            <RocketIcon />
            Launch
          </Button>
        </footer>
      </div>
    </div>
  );
});
