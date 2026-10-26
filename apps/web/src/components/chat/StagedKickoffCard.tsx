import { memo } from "react";
import { PencilIcon, RocketIcon } from "lucide-react";

import type { EnvironmentId } from "@t3tools/contracts";
import ChatMarkdown from "../ChatMarkdown";
import { useProjectAbsoluteFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { StagedCard } from "./StagedCard";

interface StagedKickoffCardProps {
  readonly environmentId: EnvironmentId;
  /** The held thread's `workstream.kickoffBriefPath`, read through the absolute file RPC. */
  readonly kickoffBriefPath: string;
  readonly markdownCwd?: string | undefined;
  readonly launchDisabled?: boolean;
  /** Why the composer cannot send yet; Launch waits, showing this, until it clears. */
  readonly launchBlockedReason?: string | null;
  /** Space to reserve at the bottom so the card clears the composer overlay. */
  readonly bottomInset?: number;
  readonly onLaunch: (brief: string) => void;
  readonly onEditFirst: (brief: string) => void;
}

/**
 * loom: the kickoff offer on a staged (held) root, from `goal_continue` or `thread_fork`.
 * Launch sends the brief through the composer's ordinary send; there is no release control,
 * because the first human message is what clears `held`.
 */
export const StagedKickoffCard = memo(function StagedKickoffCard({
  environmentId,
  kickoffBriefPath,
  markdownCwd,
  launchDisabled,
  launchBlockedReason,
  bottomInset,
  onLaunch,
  onEditFirst,
}: StagedKickoffCardProps) {
  const { data, error, isPending } = useProjectAbsoluteFileQuery(environmentId, kickoffBriefPath);
  const brief = data?.contents.trim() ? data.contents : null;
  return (
    <StagedCard
      badgeLabel="Staged"
      badgeIcon={<RocketIcon className="size-3" />}
      title="Staged kickoff"
      bottomInset={bottomInset}
      footer={
        <>
          {launchBlockedReason ? (
            <span className="mr-auto text-muted-foreground text-xs">{launchBlockedReason}</span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={brief === null}
            onClick={() => brief && onEditFirst(brief)}
          >
            <PencilIcon />
            Edit first
          </Button>
          <Button
            size="sm"
            disabled={brief === null || launchDisabled || !!launchBlockedReason}
            onClick={() => brief && onLaunch(brief)}
          >
            <RocketIcon />
            Launch
          </Button>
        </>
      }
    >
      {brief !== null ? (
        <ChatMarkdown text={brief} cwd={markdownCwd} environmentId={environmentId} />
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
