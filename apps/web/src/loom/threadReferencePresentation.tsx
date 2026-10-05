/**
 * loom: how a `#`-mentioned thread renders as a context chip. Shared by the
 * composer registry (slice 2) and the transcript's renderContextReference
 * (slice 3), so both surfaces show the same thing.
 */
import type { ReactElement } from "react";

import { ThreadTagChipContent } from "../components/chat/FileTagChip";
import { ContextChip } from "../components/ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { ThreadReferenceDraft } from "./threadReference";

export function ThreadContextChip(props: { reference: ThreadReferenceDraft }): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // A thread's accent is the mention hue: both name something already in the app.
          <ContextChip kind="mention" aria-label={`Thread, ${props.reference.label}`}>
            <ThreadTagChipContent label={props.reference.label} />
          </ContextChip>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap">
        {`Thread\n${props.reference.threadId}`}
      </TooltipPopup>
    </Tooltip>
  );
}
