/**
 * loom: the change ruler beside an opened changed file's scrollbar (a band per change where it
 * sits in the file, and the part of the file on screen, as VS Code's overview ruler shows them)
 * and the header's "n of m" with previous and next.
 *
 * @module loom/review/ChangeRuler
 */
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { type PointerEvent, useEffect, useRef } from "react";

import type { AnnotatableCodeViewHandle } from "../../components/diffs/AnnotatableCodeView";
import { FileSurfaceAction } from "../../components/files/fileSurfaceChrome";
import { type RulerChange, useChangeNavigationStore } from "./changeNavigation";

const MIN_BAND_PX = 4;
/** Movement past this turns a press on a band from a click (jump to it) into a drag. */
const DRAG_THRESHOLD_PX = 3;

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
  // `grab` is where in the viewport block the cursor holds it, null until a band press moves far
  // enough to count as a drag. `draggedRef` stops the band's click jumping after a drag.
  const dragRef = useRef<{ x: number; y: number; grab: number | null } | null>(null);
  const draggedRef = useRef(false);
  const scrollRoot = () => codeView?.getInstance()?.getContainerElement() ?? null;
  // Puts the viewport block's top at `y - grab` (ruler px), like dragging a scrollbar thumb.
  const scrollTo = (ruler: HTMLElement, y: number, grab: number) => {
    const root = scrollRoot();
    if (root) root.scrollTop = ((y - grab) / ruler.clientHeight) * root.scrollHeight;
  };
  // Inside the block keeps the grab offset; elsewhere the view centres on the cursor.
  const grabAt = (ruler: HTMLElement, y: number) => {
    const block = viewportRef.current;
    const root = scrollRoot();
    if (block && y >= block.offsetTop && y <= block.offsetTop + block.offsetHeight)
      return y - block.offsetTop;
    return root && root.scrollHeight > 0
      ? ((root.clientHeight / root.scrollHeight) * ruler.clientHeight) / 2
      : 0;
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    // The code view holds a jump's target until a wheel or press on its own scroller, which would
    // pull it back from a drag; a synthetic wheel scrolls nothing and drops that target.
    scrollRoot()?.dispatchEvent(new Event("wheel"));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const ruler = event.currentTarget;
    const y = event.clientY - ruler.getBoundingClientRect().top;
    draggedRef.current = false;
    // A band press waits to see whether it is a click, uncaptured so the click reaches the band;
    // a track press scrolls at once. Capture keeps the drag once the cursor leaves the strip.
    const onBand = (event.target as Element).closest("button") !== null;
    const grab = onBand ? null : grabAt(ruler, y);
    dragRef.current = { x: event.clientX, y, grab };
    if (grab !== null) {
      startDrag(event);
      scrollTo(ruler, y, grab);
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    // A band press released off the strip, before it became a drag, never sends its pointerup here.
    if (!drag || event.buttons === 0) return void (dragRef.current = null);
    const ruler = event.currentTarget;
    const y = event.clientY - ruler.getBoundingClientRect().top;
    if (drag.grab === null) {
      if (Math.hypot(event.clientX - drag.x, y - drag.y) <= DRAG_THRESHOLD_PX) return;
      draggedRef.current = true;
      drag.grab = grabAt(ruler, drag.y);
      startDrag(event);
    }
    scrollTo(ruler, y, drag.grab);
  };
  const endDrag = () => {
    dragRef.current = null;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the code view's scroll and writes the viewport mark to the DOM
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
      className="relative w-3.5 shrink-0 touch-none overflow-hidden border-l bg-muted/40 select-none"
      data-loom-change-ruler=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
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
          onClick={() => {
            if (!draggedRef.current) useChangeNavigationStore.getState().jump(index);
          }}
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
