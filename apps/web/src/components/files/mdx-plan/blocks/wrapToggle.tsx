import { IconTextWrap } from "@tabler/icons-react";

import { cn } from "~/lib/utils";

/**
 * Shared header control (§5) that toggles soft-wrapping of long lines/strings in
 * `<Code>` / `<AnnotatedCode>` / `<Json>` / `<Diff>`. Same visual language as
 * `<Diff>`'s Unified/Split `ModeButton`: a small `aria-pressed` toggle that lives
 * in the block's `figcaption` header. The wrap mechanics differ per block (a
 * `plan-code-wrap` class on Shiki, `whitespace-*` on diff/json spans); this is
 * only the button.
 */
export function WrapToggle({ wrapped, onToggle }: { wrapped: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={wrapped}
      aria-label="Toggle text wrapping"
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium transition-colors",
        wrapped ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/80",
      )}
    >
      <IconTextWrap className="size-3" />
      Wrap
    </button>
  );
}
