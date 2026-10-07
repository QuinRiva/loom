import { refreshOnSignalWhileRead } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentSnapshotAtom } from "../state/shell";

const liveThreadIdsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentSnapshotAtom(environmentId))
        ?.threads.map((thread) => thread.id)
        .join() ?? "",
  ),
);

/**
 * The archived-shell snapshot is a query, so upstream refreshes it only after this
 * client's own archive actions. That misses an archive or unarchive from anywhere else —
 * another client, or the cascade Loom's server runs over a root's descendants after the
 * root's own command returns. Re-read it whenever a thread enters or leaves the
 * environment's live (streamed) shell, i.e. on every archive-state change.
 */
export const withLiveShellRefresh = <A>(query: (environmentId: EnvironmentId) => Atom.Atom<A>) =>
  Atom.family((environmentId: EnvironmentId) =>
    query(environmentId).pipe(refreshOnSignalWhileRead(liveThreadIdsAtom(environmentId))),
  );
