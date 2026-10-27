import { observeResize } from "~/lib/observeResize";
import { useRightPanelStore } from "~/rightPanelStore";

/**
 * loom: file previews reopen where the reader left them. Positions live in memory for the
 * session (like the chat timeline's `rememberTimelinePosition`): they must survive a thread
 * switch, which remounts the surface, but not a reload, so nothing touches storage per frame.
 */
interface RememberedScroll {
  readonly top: number;
  /** The file's reveal request when this was recorded: that reveal has been consumed. */
  readonly revealRequestId?: number;
  /** Code views: the top line, since a remount re-estimates wrapped line heights above it. */
  anchor?:
    | {
        readonly line: number;
        readonly offset: number;
        readonly side?: "additions" | "deletions";
      }
    | undefined;
}

const MAX_REMEMBERED = 200;
/** Frames the target must hold once reached: a virtualizer re-measuring after mount moves it. */
const HOLD_FRAMES = 30;
const remembered = new Map<string, RememberedScroll>();
/** The key each scroller last finished restoring, so a re-attach on re-render never re-arms it. */
const settled = new WeakMap<Element, string>();

export function readRememberedScroll(key: string) {
  return remembered.get(key);
}

export function rememberScroll(key: string, entry: RememberedScroll) {
  remembered.delete(key);
  remembered.set(key, entry);
  const oldest = remembered.keys().next().value;
  if (remembered.size > MAX_REMEMBERED && oldest !== undefined) remembered.delete(oldest);
}

const filePrefix = (threadKey: string, filePath: string) => `${threadKey}\u0000${filePath}\u0000`;

/** The key a file tab's positions share; callers append the view. */
export const fileScrollKey = (threadKey: string, filePath: string, cwd: string) =>
  `${filePrefix(threadKey, filePath)}${cwd}`;

// A recreated file tab restarts its reveal ids at 1, so a closed tab's positions go with it: a
// stale entry would match the new tab's first reveal and swallow it.
useRightPanelStore.subscribe(({ byThreadKey }, previous) => {
  for (const [threadKey, panel] of Object.entries(previous.byThreadKey)) {
    const surfaces = byThreadKey[threadKey]?.surfaces;
    if (surfaces === panel.surfaces) continue;
    for (const closed of panel.surfaces) {
      if (closed.kind !== "file" || surfaces?.some((surface) => surface.id === closed.id)) continue;
      const prefix = filePrefix(threadKey, closed.relativePath);
      for (const key of remembered.keys()) if (key.startsWith(prefix)) remembered.delete(key);
    }
  }
});

const lines = (scroller: Element) =>
  scroller
    .querySelector("diffs-container")
    ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]");

function lineAnchor(scroller: Element) {
  const top = scroller.getBoundingClientRect().top;
  for (const line of lines(scroller) ?? []) {
    const rect = line.getBoundingClientRect();
    if (rect.bottom > top) return { line: Number(line.dataset.line), offset: top - rect.top };
  }
  return undefined;
}

/** Per virtualized scroller: a line's scroll offset from the virtualizer's own geometry. */
const lineTops = new WeakMap<Element, (line: number) => number | undefined>();

export function setLineTopResolver(
  scroller: Element,
  lineTop: (line: number) => number | undefined,
) {
  lineTops.set(scroller, lineTop);
}

const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

/** The viewport of the `ScrollArea` whose root is given. */
export const scrollAreaViewport = (root: HTMLElement | null) =>
  root?.querySelector(VIEWPORT_SELECTOR);

/**
 * Ref callback for a preview's scroller: records its position under `key`, and on attach returns
 * to it, re-applying as content grows (the MDX compile lands after mount) until it holds or the
 * reader takes over. `holdRestore` yields to a pending line reveal.
 */
export function rememberedScrollRef(
  key: string,
  revealRequestId: number,
  holdRestore: boolean,
): (scroller: Element | null | undefined) => (() => void) | undefined {
  return (scroller) => {
    if (!scroller) return undefined;
    const saved = remembered.get(key);
    const goal = () => {
      const anchor = saved?.anchor;
      const lineTop = anchor ? lineTops.get(scroller)?.(anchor.line) : undefined;
      return Math.max(
        0,
        anchor && lineTop !== undefined ? lineTop + anchor.offset : (saved?.top ?? 0),
      );
    };
    // Not "already at target": a re-render re-attaches mid-hold, and the hold must resume.
    let restoring = !holdRestore && settled.get(scroller) !== key;
    let anchorTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (restoring) return;
      const entry: RememberedScroll = { top: scroller.scrollTop, revealRequestId };
      rememberScroll(key, entry);
      // One layout read once scrolling pauses, not one per scroll frame.
      clearTimeout(anchorTimer);
      anchorTimer = setTimeout(() => {
        if (scroller.isConnected && remembered.get(key) === entry)
          entry.anchor = lineAnchor(scroller);
      }, 150);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // The scrollbar of a `ScrollArea` sits beside its viewport, so listen on the parent.
    const inputRoot = scroller.parentElement ?? scroller;
    const content = scroller.firstElementChild;
    let unobserve = () => {};
    let frame = 0;
    let heldFrames = 0;
    const stop = () => {
      restoring = false;
      unobserve();
      cancelAnimationFrame(frame);
      scroller.removeEventListener("wheel", finish);
      scroller.removeEventListener("touchstart", finish);
      scroller.removeEventListener("keydown", finish);
      inputRoot.removeEventListener("pointerdown", finish, true);
    };
    const finish = () => {
      settled.set(scroller, key);
      stop();
    };
    // `landed` is false while the content is still too short to reach the goal.
    const apply = () => {
      const top = goal();
      const held = Math.abs(scroller.scrollTop - top) <= 1;
      if (!held) scroller.scrollTop = top;
      return { held, landed: Math.abs(scroller.scrollTop - top) <= 1 };
    };
    // Once it lands, hold it per frame; while the content is short, wait for it to grow.
    const hold = () => {
      frame = requestAnimationFrame(() => {
        frame = 0;
        const { held, landed } = apply();
        heldFrames = held ? heldFrames + 1 : 0;
        if (heldFrames >= HOLD_FRAMES) finish();
        else if (landed) hold();
      });
    };
    const restore = () => {
      if (apply().landed && frame === 0) hold();
    };
    if (restoring) {
      restore();
      unobserve = observeResize(content ? [content, scroller] : scroller, restore);
      scroller.addEventListener("wheel", finish, { passive: true });
      scroller.addEventListener("touchstart", finish, { passive: true });
      scroller.addEventListener("keydown", finish);
      inputRoot.addEventListener("pointerdown", finish, { passive: true, capture: true });
    }
    return () => {
      stop();
      scroller.removeEventListener("scroll", onScroll);
    };
  };
}
