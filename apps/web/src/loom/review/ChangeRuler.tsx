/**
 * loom: the change ruler beside an opened changed file's scrollbar (a band per change where it
 * sits in the file, and the part of the file on screen, as VS Code's overview ruler shows them)
 * and the header's "n of m" with previous and next.
 *
 * @module loom/review/ChangeRuler
 */
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { AnnotatableCodeViewHandle } from "../../components/diffs/AnnotatableCodeView";
import { FileSurfaceAction } from "../../components/files/fileSurfaceChrome";
import { type RulerChange, useChangeNavigationStore } from "./changeNavigation";

const MIN_BAND_PX = 4;

/**
 * Bands sit at their row over the file's rows. Under word wrap a long line is taller than a row,
 * so a band can sit a little off its change's place on the scrollbar; VS Code's ruler is by line
 * too, and the view is virtualised, so rows are the only positions known for the whole file.
 */
export function ChangeRuler({
  codeView,
  changes,
  totalRows,
}: {
  codeView: AnnotatableCodeViewHandle | null;
  changes: ReadonlyArray<RulerChange>;
  totalRows: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewer = codeView?.getInstance();
    const root = viewer?.getContainerElement();
    if (!viewer || !root) return;
    // Written straight to the element: a scroll never re-renders React.
    const place = () => {
      const style = viewportRef.current?.style;
      if (!style || root.scrollHeight === 0) return;
      style.top = `${(root.scrollTop / root.scrollHeight) * 100}%`;
      style.height = `${(root.clientHeight / root.scrollHeight) * 100}%`;
    };
    place();
    return viewer.subscribeToScroll(place);
  }, [codeView]);
  if (changes.length === 0 || totalRows === 0) return null;
  return (
    <div
      className="relative w-3.5 shrink-0 overflow-hidden border-l bg-muted/40"
      data-loom-change-ruler=""
    >
      <div
        ref={viewportRef}
        className="pointer-events-none absolute inset-x-0 min-h-3 bg-foreground/15"
      />
      {changes.map((change, index) => (
        <button
          key={change.start}
          type="button"
          tabIndex={-1}
          aria-label={`Change ${index + 1} of ${changes.length}, line ${change.lineNumber}`}
          className="absolute inset-x-0.5 flex cursor-pointer overflow-hidden rounded-xs hover:opacity-70"
          style={{
            top: `min(${(change.start / totalRows) * 100}%, 100% - ${MIN_BAND_PX}px)`,
            height: `max(${(change.rows / totalRows) * 100}%, ${MIN_BAND_PX}px)`,
          }}
          onClick={() => useChangeNavigationStore.getState().jump(index)}
        >
          {/* A modification is both: old on the left, new on the right, as side by side shows it. */}
          {change.deletions > 0 ? <span className="flex-1 bg-diff-deletion" /> : null}
          {change.additions > 0 ? <span className="flex-1 bg-diff-addition" /> : null}
        </button>
      ))}
    </div>
  );
}

/** "3 of 7" with previous and next, for whichever change view is open. */
export function LoomChangeCounter() {
  const count = useChangeNavigationStore((state) => state.count);
  const current = useChangeNavigationStore((state) => state.current);
  if (count === 0) return null;
  const step = (delta: 1 | -1) => useChangeNavigationStore.getState().step(delta);
  return (
    <div className="flex shrink-0 items-center">
      <FileSurfaceAction label="Previous change  [" onPress={() => step(-1)}>
        <ChevronUpIcon className="size-3.5" />
      </FileSurfaceAction>
      <span className="text-muted-foreground text-xs tabular-nums whitespace-nowrap">
        {current + 1} of {count}
      </span>
      <FileSurfaceAction label="Next change  ]" onPress={() => step(1)}>
        <ChevronDownIcon className="size-3.5" />
      </FileSurfaceAction>
    </div>
  );
}
