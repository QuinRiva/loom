import {
  type ArchivedSnapshotEntry,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef } from "react";

import { environmentSnapshotAtom } from "../state/shell";

// `env:id` of every live thread across the environments, or null while any shell is
// unloaded. A string so it only changes when membership does, not on every shell update.
const liveThreadKeysAtom = Atom.family((environmentKey: string) =>
  Atom.make((get) => {
    const keys: string[] = [];
    for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
      const snapshot = get(environmentSnapshotAtom(environmentId));
      if (!snapshot) return null;
      keys.push(...snapshot.threads.map((thread) => `${environmentId}:${thread.id}`));
    }
    return keys.join("\n");
  }),
);

/**
 * Settings → Archive is a one-shot query that upstream refreshes only after this client's
 * own actions, so archives and unarchives from elsewhere (another client, or the cascade
 * Loom's server runs over a root's descendants) never reach it. Refresh exactly when
 * archived membership changes as seen from the streamed live shell: a live thread leaves
 * it (archived or deleted), or a thread the page lists as archived appears in it
 * (unarchived). A thread being created changes neither, so it costs nothing.
 */
export function useArchiveMembershipRefresh(
  environmentIds: ReadonlyArray<EnvironmentId>,
  archived: ReadonlyArray<ArchivedSnapshotEntry>,
  refresh: () => void,
) {
  const live = useAtomValue(liveThreadKeysAtom(makeArchivedThreadsEnvironmentKey(environmentIds)));
  const previous = useRef<ReadonlySet<string> | null>(null);
  // An effect event, so only a live-membership change triggers it, never a refetched list.
  const onLiveChange = useEffectEvent((current: ReadonlySet<string>) => {
    const left =
      previous.current !== null && [...previous.current].some((key) => !current.has(key));
    previous.current = current;
    const unarchived = archived.some(({ environmentId, snapshot }) =>
      snapshot.threads.some((thread) => current.has(`${environmentId}:${thread.id}`)),
    );
    if (left || unarchived) refresh();
  });
  useEffect(() => {
    if (live !== null) onLiveChange(new Set(live.split("\n")));
  }, [live]);
}
