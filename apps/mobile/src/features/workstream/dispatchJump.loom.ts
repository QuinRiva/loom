/**
 * loom: "Show where it was dispatched" (plan §7): resolves the parked spawn time to the last loaded
 * message at or before it, paging earlier history (20 pages at most) while the oldest loaded entry
 * is newer, and hands it to the thread screen's message jump. Nothing found: the thread stays put.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { ThreadFeedHistoryControls } from "../threads/ThreadFeed";
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import {
  finishDispatchJump,
  pendingDispatchJump,
  subscribeDispatchJump,
} from "./workstreamNavigation.loom";

const MAX_PAGES = 20;

export function useDispatchJump(
  threadKey: string,
  feed: ReadonlyArray<ThreadFeedEntry>,
  history: ThreadFeedHistoryControls | undefined,
  ready: boolean,
) {
  const at = useSyncExternalStore(subscribeDispatchJump, () => pendingDispatchJump(threadKey));
  const pages = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pages earlier history from the server until the spawn time is loaded, then hands off to the message jump
  useEffect(() => {
    if (at === null || !ready || history?.loading) return;
    const oldest = feed.reduce<string | null>(
      (min, entry) => (min === null || entry.createdAt < min ? entry.createdAt : min),
      null,
    );
    if (
      (oldest === null || oldest > at) &&
      history?.hasMoreHistory &&
      history.error === null &&
      pages.current < MAX_PAGES
    ) {
      pages.current += 1;
      history.onLoadEarlier();
      return;
    }
    const target = feed.findLast((entry) => entry.type === "message" && entry.createdAt <= at);
    pages.current = 0;
    finishDispatchJump(threadKey);
    if (target?.type === "message") requestThreadMessageJump(threadKey, target.message.id);
  }, [at, feed, history, ready, threadKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a jump this thread never reached lets go when the thread changes or closes
  useEffect(
    () => () => {
      pages.current = 0;
      finishDispatchJump(threadKey);
    },
    [threadKey],
  );
}
