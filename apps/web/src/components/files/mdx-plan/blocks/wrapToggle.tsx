import { IconTextWrap } from "@tabler/icons-react";

import { cn } from "~/lib/utils";

/**
 * Header toggle for soft-wrapping long lines in `<Code>`, `<AnnotatedCode>`, `<Json>` and
 * `<Diff>`, styled like `<Diff>`'s mode button. Each block owns its own wrap mechanics.
 */
export function WrapToggle({ wrapped, onToggle }: { wrapped: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={wrapped}
      aria-label="Toggle text wrapping"
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-3xs font-medium transition-colors",
        wrapped ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/80",
      )}
    >
      <IconTextWrap className="size-3" />
      Wrap
    </button>
  );
}
