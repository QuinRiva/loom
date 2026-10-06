/**
 * loom: a message's Loom fields (`origin`, `controlPayload`) by message id
 * (3d-3, Phase 2 D8). Turn items carry only the text; the fields ride the
 * thread projection's `messages`. One index per thread, rebuilt only when the
 * messages array changes, and one selector per row — so a row re-renders only
 * when its own message's fields change, never on a streaming delta elsewhere.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  LoomMessageFields,
  MessageId,
  OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "../state/threads";

const EMPTY_INDEX: ReadonlyMap<string, LoomMessageFields> = new Map();

const indexAtom = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  let previousMessages: ReadonlyArray<OrchestrationV2ConversationMessage> | null = null;
  let previous = EMPTY_INDEX;
  return Atom.make((get) => {
    const messages =
      ref === null
        ? null
        : (get(environmentThreadDetails.threadAtom(ref))?.projection.messages ?? null);
    if (messages === null) return EMPTY_INDEX;
    if (messages !== previousMessages) {
      previousMessages = messages;
      previous = new Map(
        messages.flatMap((message) => (message.loom ? [[message.id, message.loom] as const] : [])),
      );
    }
    return previous;
  }).pipe(Atom.withLabel(`loom-message-fields:${threadKey}`));
});

const fieldsAtom = Atom.family((key: string) => {
  const separator = key.indexOf("|");
  const threadKey = key.slice(0, separator);
  const messageId = key.slice(separator + 1);
  return Atom.make((get) => get(indexAtom(threadKey)).get(messageId) ?? null).pipe(
    Atom.withLabel(`loom-message-field:${key}`),
  );
});

export function useLoomMessageFields(
  threadKey: string,
  messageId: MessageId,
): LoomMessageFields | null {
  return useAtomValue(fieldsAtom(`${threadKey}|${messageId}`));
}
