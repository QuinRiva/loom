import type { LoomPromptCaptureResult, ThreadId } from "@t3tools/contracts";
import { BugIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isAbsolutePreviewablePath } from "../markdown-links";
import { useAtomCommand } from "../state/use-atom-command";
import { loomCommands } from "./loomGoalState";
import { WorkstreamEnvironmentContext } from "./WorkstreamSpendSlot";

const previewable = (path: string | null | undefined) =>
  path && isAbsolutePreviewablePath(path) ? path : null;

/**
 * The workstream surface's Prompt menu: opens a thread's captured system prompt (pi's prompt-debug
 * sidecar), the latest agent start's or the kickoff's. Asks `loom.promptCapture` when the thread or
 * `refreshKey` changes (only a capture's existence can change; the file is read fresh on open).
 * Renders nothing until a capture exists.
 */
export function PromptCaptureMenu({
  threadId,
  refreshKey,
  onOpen,
}: {
  readonly threadId: ThreadId;
  readonly refreshKey: string;
  readonly onOpen: (path: string) => void;
}) {
  const environmentId = useContext(WorkstreamEnvironmentContext);
  const load = useAtomCommand(loomCommands.promptCapture, { reportFailure: false });
  const [loaded, setLoaded] = useState<{
    readonly threadId: ThreadId;
    readonly capture: LoomPromptCaptureResult;
  } | null>(null);
  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    void load({ environmentId, input: { threadId } }).then((result) => {
      if (!cancelled && result._tag === "Success") setLoaded({ threadId, capture: result.value });
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A refresh re-reads the capture.
  }, [environmentId, threadId, refreshKey, load]);
  const capture = loaded?.threadId === threadId ? loaded.capture : null;
  const latest = previewable(capture?.latest);
  const first = previewable(capture?.first);
  if (latest === null) return null;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="outline" aria-label="Open captured system prompt" />
              }
            >
              <BugIcon />
            </MenuTrigger>
          }
        />
        <TooltipPopup>Captured system prompt</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        <MenuItem onClick={() => onOpen(latest)}>Latest system prompt</MenuItem>
        {first ? <MenuItem onClick={() => onOpen(first)}>Kickoff prompt</MenuItem> : null}
      </MenuPopup>
    </Menu>
  );
}
