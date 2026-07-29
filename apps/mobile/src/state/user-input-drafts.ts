/**
 * In-progress answers for open agent questions, keyed by `(environmentId, requestId)`.
 *
 * `Atom.keepAlive` so a partially answered request survives a thread switch — the
 * property web adopted from mobile (client audit S7). Eviction is the shared rule
 * from `@t3tools/shared/userInputAnswers`, deliberately not a local copy: this atom
 * previously evicted by ENVIRONMENT prefix against the selected thread's open set,
 * which deleted another thread's partially typed answer on every thread switch
 * while web's copy of "the same" rule did not.
 *
 * Kept apart from `use-selected-thread-requests.ts` so the state is reachable
 * without importing that hook's React Native component graph.
 */
import { Atom } from "effect/unstable/reactivity";

import type { UserInputAnswerDraftEntries } from "@t3tools/shared/userInputAnswers";

import { appAtomRegistry } from "./atom-registry";

export const userInputDraftsAtom = Atom.make<UserInputAnswerDraftEntries>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:user-input-drafts"),
);

/** Apply a shared transition, skipping the write when it changed nothing. */
export function updateUserInputDrafts(
  update: (entries: UserInputAnswerDraftEntries) => UserInputAnswerDraftEntries,
): void {
  const current = appAtomRegistry.get(userInputDraftsAtom);
  const next = update(current);
  if (next !== current) {
    appAtomRegistry.set(userInputDraftsAtom, next);
  }
}
