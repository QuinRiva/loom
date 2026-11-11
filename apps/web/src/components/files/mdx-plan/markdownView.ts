import { createContext, useContext, useState } from "react";

export type MarkdownView = "rendered" | "source";

/**
 * The document-wide Rendered/Source choice for markdown `<Code>` blocks, held by
 * `MdxPlanRenderer` for as long as the document is open. `view` is null until the reader
 * first flips a block; until then each block shows its authored `view`.
 */
export const PlanMarkdownViewContext = createContext<{
  view: MarkdownView | null;
  setView: (view: MarkdownView) => void;
} | null>(null);

/** A markdown block's current view and its switch. Without a provider (`lint-plan.mjs`,
 * tests) the block keeps the choice to itself. */
export function useMarkdownView(authored: MarkdownView | undefined) {
  const document = useContext(PlanMarkdownViewContext);
  const [local, setLocal] = useState<MarkdownView | null>(null);
  return [
    (document ? document.view : local) ?? authored ?? "rendered",
    document?.setView ?? setLocal,
  ] as const;
}
