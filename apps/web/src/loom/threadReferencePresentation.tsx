/**
 * loom: how a `#`-mentioned thread renders as a context chip. Shared by the
 * composer registry (slice 2) and the transcript's renderContextReference
 * (slice 3), so both surfaces show the same thing.
 */
import type { ReactElement } from "react";

import { ThreadTagChipContent } from "../components/chat/FileTagChip";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES,
} from "../components/composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { ThreadReferenceDraft } from "./threadReference";

/** A thread's accent is the mention hue: both name something already in the app. */
export const THREAD_CONTEXT_CHIP_TONE_CLASS_NAME = CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES.mention;

export function ThreadContextChip(props: { reference: ThreadReferenceDraft }): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={`Thread, ${props.reference.label}`}
            className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, THREAD_CONTEXT_CHIP_TONE_CLASS_NAME)}
          >
            <ThreadTagChipContent label={props.reference.label} />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {`Thread\n${props.reference.threadId}`}
      </TooltipPopup>
    </Tooltip>
  );
}
