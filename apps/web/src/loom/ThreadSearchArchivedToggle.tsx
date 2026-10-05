// The sidebar search's archived toggle: flips the same per-device
// `threadSearchIncludeArchived` preference as Settings → General → Thread search.
import { ArchiveIcon, ArchiveXIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";

export function ThreadSearchArchivedToggle() {
  const included = useClientSettings((settings) => settings.threadSearchIncludeArchived);
  const updateSettings = useUpdateClientSettings();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-micro"
            variant={included ? "ghost" : "ghost-muted"}
            aria-pressed={included}
            aria-label="Include archived threads"
            onClick={() => void updateSettings({ threadSearchIncludeArchived: !included })}
            className="shrink-0"
          />
        }
      >
        {included ? <ArchiveIcon className="size-3" /> : <ArchiveXIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {included ? "Including archived threads" : "Archived threads hidden"}
      </TooltipPopup>
    </Tooltip>
  );
}
