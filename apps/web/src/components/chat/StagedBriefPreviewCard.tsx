import { memo } from "react";
import { FileTextIcon } from "lucide-react";

import type { EnvironmentId } from "@t3tools/contracts";
import ChatMarkdown from "../ChatMarkdown";
import { useProjectAbsoluteFileQuery } from "../files/projectFilesQueryState";
import { StagedCard } from "./StagedCard";

interface StagedBriefPreviewCardProps {
  readonly environmentId: EnvironmentId;
  readonly kickoffBriefPath: string;
  readonly markdownCwd?: string | undefined;
  /** Space to reserve at the bottom so the card clears the composer overlay. */
  readonly bottomInset?: number;
}

/**
 * loom: read-only preview of a Loom child's kickoff brief before its first run
 * (a scaffolded child waiting on its dependencies). It carries no actions: the
 * control plane launches the child once its dependencies clear — this surface
 * exists so a human can read the brief first.
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
