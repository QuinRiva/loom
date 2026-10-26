import type {
  EnvironmentId,
  LoomConsultShellStreamItem,
  LoomLiveConsult,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Live consults from `consult.updated` items, kept off the shell snapshot (persisted on every write)
 * since they change at a running fork's tool boundaries. Keyed by environment, asker thread and
 * question key, so a card re-renders only for its own consult. A finished consult is kept for the
 * session; a reload starts empty and the subscription replays only the running ones.
 */
const consults = new Map<string, ReadonlyArray<LoomLiveConsult>>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: ReadonlyArray<LoomLiveConsult> = Object.freeze([]);

export const liveConsultKey = (
  environmentId: EnvironmentId,
  askerThreadId: ThreadId,
  questionKey: string,
) => `${environmentId}\u0000${askerThreadId}\u0000${questionKey}`;

export function applyLoomConsultItem(
  environmentId: EnvironmentId,
  { consult }: LoomConsultShellStreamItem,
): void {
  const key = liveConsultKey(environmentId, consult.askerThreadId, consult.questionKey);
  const list = consults.get(key) ?? EMPTY;
  const current = list.find((entry) => entry.consultId === consult.consultId);
  // An ended consult is final: a replayed running copy never revives it.
  if (current?.endedAt != null) return;
  consults.set(
    key,
    current === undefined
      ? [...list, consult]
      : list.map((entry) => (entry === current ? consult : entry)),
  );
  for (const listener of listeners.get(key) ?? []) listener();
}

/** Every consult the asker ran with this question this session, oldest first. */
export const getLiveConsults = (key: string): ReadonlyArray<LoomLiveConsult> =>
  consults.get(key) ?? EMPTY;

export function subscribeLiveConsults(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set.add(listener));
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}
