import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArchiveIcon } from "lucide-react";
import { useState } from "react";

import { ThreadStatusLine } from "../components/chat/ThreadStatusLine";
import { useThreadActions } from "../hooks/useThreadActions";
import { formatRelativeTimeLabel } from "../timestampFormat";

/**
 * An archived root opened from thread search reads as archived, with the way
 * back to working on it beside the label; opening it never unarchives it.
 */
export function ArchivedThreadStatusLine(props: {
  readonly threadRef: ScopedThreadRef;
  readonly archivedAt: string;
  readonly clockMinute: string;
  readonly disabled: boolean;
}) {
  const { unarchiveThread } = useThreadActions();
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  return (
    <ThreadStatusLine
      icon={<ArchiveIcon />}
      label={`Archived ${formatRelativeTimeLabel(props.archivedAt)}`}
      clockMinute={props.clockMinute}
      actionLabel={isUnarchiving ? "Unarchiving..." : "Unarchive"}
      actionDisabled={props.disabled || isUnarchiving}
      onAction={() => {
        setIsUnarchiving(true);
        void unarchiveThread(props.threadRef).finally(() => setIsUnarchiving(false));
      }}
    />
  );
}
