import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  guessThreadLinkRef,
  percentDecodedThreadLinkId,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { useThreadRefs, useThreadShell } from "../../state/entities";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadMention } from "../../loom/ThreadMention"; // loom: status-led mention

// loom: `ThreadMention` leads with the thread's live state instead of upstream's context chip,
// keeping the favicon only for a thread in another project than `fromThreadRef`'s.
/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
  readonly fromThreadRef?: ScopedThreadRef | undefined; // loom: the message's own thread
}) {
  const environmentId = props.link.environmentId ?? props.environmentId;
  const decodedId = percentDecodedThreadLinkId(props.link.threadId);
  const written = useThreadShell(scopeThreadRef(environmentId, props.link.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  const guess = local === null && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remote = useThreadShell(guess ? guessThreadLinkRef(props.link, refs) : null);
  const thread = local ?? remote;
  if (thread === null) {
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const title = thread.title.trim() || props.label || "Untitled thread";
  return (
    <ThreadMention
      environmentId={thread.environmentId}
      threadId={thread.id}
      title={title}
      thread={thread}
      fromThreadRef={props.fromThreadRef}
    />
  );
}
