/**
 * loom: each Loom-originated message's card (`controlCardModel`) or labelled bubble, by message id,
 * read from the projection's `messages` since turn items carry only text. The result keeps its
 * identity until a card or bubble is added or changes, so streamed text never re-renders the feed.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  controlBubble,
  type ControlBubble,
} from "@t3tools/client-runtime/state/loom/controlBubble";
import {
  controlCardModel,
  type ControlCardModel,
} from "@t3tools/client-runtime/state/loom/controlCard";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "../../state/threads";

export interface ControlMessages {
  readonly cards: ReadonlyMap<string, ControlCardModel>;
  readonly bubbles: ReadonlyMap<string, ControlBubble>;
}

const EMPTY: ControlMessages = { cards: new Map(), bubbles: new Map() };

const controlMessagesAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  let previousKey = "";
  let previous = EMPTY;
  return Atom.make((get) => {
    const messages =
      get(environmentThreadDetails.threadAtom({ environmentId, threadId }))?.projection.messages ??
      [];
    const cards: Array<readonly [string, ControlCardModel]> = [];
    const bubbles: Array<readonly [string, ControlBubble]> = [];
    for (const message of messages) {
      if (message.loom === undefined) continue;
      const card = controlCardModel(message.loom, message.text);
      const bubble = card === null ? controlBubble(message.loom) : null;
      if (card !== null) cards.push([message.id, card]);
      else if (bubble !== null) bubbles.push([message.id, bubble]);
    }
    const nextKey = [
      ...cards.map(([id, card]) => `${id}:${card.kind}:${card.label}`),
      ...bubbles.map(([id, bubble]) => `${id}:${bubble.label}`),
    ].join("\n");
    if (nextKey !== previousKey) {
      previousKey = nextKey;
      previous = nextKey === "" ? EMPTY : { cards: new Map(cards), bubbles: new Map(bubbles) };
    }
    return previous;
  }).pipe(Atom.withLabel(`loom-control-messages:${key}`));
});

export const useControlMessages = (environmentId: EnvironmentId, threadId: ThreadId) =>
  useAtomValue(controlMessagesAtom(JSON.stringify([environmentId, threadId])));

/** The channel's accent: inter-thread is sky, the control plane emerald (web's info / success). */
export const CONTROL_BUBBLE_CLASSES: Record<
  ControlBubble["channel"],
  { readonly label: string; readonly tint: string }
> = {
  "inter-thread": { label: "text-adaptive-sky-600-400", tint: "bg-sky-500/12" },
  "control-plane": { label: "text-adaptive-emerald-700-300", tint: "bg-emerald-500/12" },
};
