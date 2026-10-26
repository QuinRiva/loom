import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { percentDecodedThreadLinkId, resolveThreadLinkRef } from "@t3tools/shared/threadLinks";

import { useThreadRefs, useThreadShell } from "../../state/entities";
import { ThreadMention } from "../../loom/ThreadMention"; // loom: status-led mention

// loom: `ThreadMention` leads with the thread's live state instead of upstream's context chip,
// keeping the favicon only for a thread in another project than `fromThreadRef`'s.
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly fromThreadRef?: ScopedThreadRef | undefined; // loom: the message's own thread
}) {
  const decodedId = percentDecodedThreadLinkId(props.threadId);
  const written = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(props.environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  const refs = useThreadRefs(local === null);
  const remote = useThreadShell(
    local === null
      ? resolveThreadLinkRef(scopeThreadRef(props.environmentId, props.threadId), refs)
      : null,
  );
  const thread = local ?? remote;
  const environmentId = thread?.environmentId ?? props.environmentId;
  const threadId = thread?.id ?? props.threadId;
  const title = thread?.title.trim() || props.label;
  // loom: rendered by Loom's status-led mention (apps/web/src/loom/ThreadMention.tsx).
  return (
    <ThreadMention
      environmentId={environmentId}
      threadId={threadId}
      title={title}
      thread={thread}
      fromThreadRef={props.fromThreadRef}
    />
  );
}
