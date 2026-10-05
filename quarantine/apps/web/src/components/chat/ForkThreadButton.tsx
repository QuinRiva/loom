import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useForkThread } from "../../hooks/useForkThread";
import { useThreadSession } from "../../state/entities";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ForkThreadButtonProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * Thread fork (MVP): a thread-header affordance to fork the active thread into
 * a fresh draft that starts with a full copy of its conversation and diverges.
 * Only offered for a PI-backed thread that has a session: forking relies on
 * pi's native session fork, and no other driver honours it, so offering it for
 * Codex/Claude/etc. would falsely promise a context copy. Clicking navigates to
 * the new draft with the composer focused; no tokens spent until the first send.
 */
export const ForkThreadButton = memo(function ForkThreadButton({
  environmentId,
  threadId,
}: ForkThreadButtonProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const session = useThreadSession(threadRef);
  const forkThread = useForkThread();
  // Pi-only: only PiDriver honours the fork source; gate the affordance to a
  // pi-backed session so the UI never claims a context copy it cannot deliver.
  if (session === null || session.providerName !== "pi") {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fork thread"
            onClick={() => {
              void forkThread(threadRef);
            }}
          >
            <GitForkIcon />
          </Button>
        }
      />
      <TooltipPopup side="bottom">Fork thread (copies context, then diverges)</TooltipPopup>
    </Tooltip>
  );
});
