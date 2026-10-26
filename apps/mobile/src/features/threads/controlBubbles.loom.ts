/**
 * loom: each Loom-originated message's bubble (kickoff, orchestrator steer, notice) by message id.
 * Turn items carry only the text; the origin rides the thread projection's `messages`. The map keeps
 * its identity until a bubble is added or changes, so streamed text never re-renders the feed here.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  controlBubble,
  type ControlBubble,
} from "@t3tools/client-runtime/state/loom/controlBubble";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "../../state/threads";

const EMPTY: ReadonlyMap<string, ControlBubble> = new Map();

const controlBubblesAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  let previousKey = "";
  let previous = EMPTY;
  return Atom.make((get) => {
    const messages =
      get(environmentThreadDetails.threadAtom({ environmentId, threadId }))?.projection.messages ??
      [];
    const bubbles = messages.flatMap((message) => {
      const bubble = controlBubble(message.loom);
      return bubble === null ? [] : [[message.id, bubble] as const];
    });
    const nextKey = bubbles.map(([id, bubble]) => `${id}:${bubble.label}`).join("\n");
    if (nextKey !== previousKey) {
      previousKey = nextKey;
      previous = bubbles.length === 0 ? EMPTY : new Map(bubbles);
    }
    return previous;
  }).pipe(Atom.withLabel(`loom-control-bubbles:${key}`));
});

export const useControlBubbles = (environmentId: EnvironmentId, threadId: ThreadId) =>
  useAtomValue(controlBubblesAtom(JSON.stringify([environmentId, threadId])));

/** The channel's accent: inter-thread is sky, the control plane emerald (web's info / success). */
export const CONTROL_BUBBLE_CLASSES: Record<
  ControlBubble["channel"],
  { readonly label: string; readonly tint: string }
> = {
  "inter-thread": { label: "text-adaptive-sky-600-400", tint: "bg-sky-500/12" },
  "control-plane": { label: "text-adaptive-emerald-700-300", tint: "bg-emerald-500/12" },
};
