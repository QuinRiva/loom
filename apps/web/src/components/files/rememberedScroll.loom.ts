import { observeResize } from "~/lib/observeResize";

/**
 * loom: file previews reopen where the reader left them. Positions live in memory for the
 * session (like the chat timeline's `rememberTimelinePosition`): they must survive a thread
 * switch, which remounts the surface, but not a reload, so nothing touches storage per frame.
 */
interface RememberedScroll {
  readonly top: number;
  /** The file's reveal request when this was recorded: that reveal has been consumed. */
  readonly revealRequestId: number;
}

const MAX_REMEMBERED = 200;
const remembered = new Map<string, RememberedScroll>();
/** The key each scroller last finished restoring, so a re-attach on re-render never re-arms it. */
const settled = new WeakMap<Element, string>();

export function readRememberedScroll(key: string) {
  return remembered.get(key);
}

const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

/** The viewport of the `ScrollArea` whose root is given. */
export const scrollAreaViewport = (root: HTMLElement | null) =>
  root?.querySelector(VIEWPORT_SELECTOR);

/**
 * Ref callback for a preview's scroller: records its position under `key`, and on attach returns
 * to it, re-applying as content grows (the MDX compile lands after mount) until reached or the
 * reader takes over. `holdRestore` yields to a pending line reveal.
 */
export function rememberedScrollRef(
  key: string,
  revealRequestId: number,
  holdRestore: boolean,
): (scroller: Element | null | undefined) => (() => void) | undefined {
  return (scroller) => {
    if (!scroller) return undefined;
    const target = remembered.get(key)?.top ?? 0;
    let restoring =
      !holdRestore && settled.get(scroller) !== key && Math.abs(scroller.scrollTop - target) > 1;
    const onScroll = () => {
      if (restoring) return;
      remembered.delete(key);
      remembered.set(key, { top: scroller.scrollTop, revealRequestId });
      const oldest = remembered.keys().next().value;
      if (remembered.size > MAX_REMEMBERED && oldest !== undefined) remembered.delete(oldest);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // The scrollbar of a `ScrollArea` sits beside its viewport, so listen on the parent.
    const inputRoot = scroller.parentElement ?? scroller;
    const content = scroller.firstElementChild;
    let unobserve = () => {};
    const stop = () => {
      restoring = false;
      unobserve();
      scroller.removeEventListener("wheel", finish);
      scroller.removeEventListener("touchstart", finish);
      scroller.removeEventListener("keydown", finish);
      inputRoot.removeEventListener("pointerdown", finish, true);
    };
    const finish = () => {
      settled.set(scroller, key);
      stop();
    };
    const restore = () => {
      scroller.scrollTop = target;
      if (Math.abs(scroller.scrollTop - target) <= 1) finish();
    };
    if (restoring) restore();
    if (restoring) {
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
