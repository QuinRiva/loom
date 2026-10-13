import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { percentDecodedThreadLinkId } from "@t3tools/shared/threadLinks";

import { useThreadShell } from "../../state/entities";
import { ThreadMention } from "../../loom/ThreadMention"; // loom: status-led mention

/**
 * A `t3-thread://` link in chat. It shows the thread's current title, so a rename
 * reaches every message that links to it. `label` is what the message wrote,
 * shown only when this client cannot see the thread. Opens the thread in the app.
 * loom: `ThreadMention` leads with the thread's live state instead of its project
 * favicon, keeping the favicon only for a thread in another project than `fromThreadRef`'s.
 */
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
  const thread = written ?? decoded;
  const threadId = thread?.id ?? props.threadId;
  const title = thread?.title.trim() || props.label;
  // loom: rendered by Loom's status-led mention (apps/web/src/loom/ThreadMention.tsx).
  return (
    <ThreadMention
      environmentId={props.environmentId}
      threadId={threadId}
      title={title}
      thread={thread}
      fromThreadRef={props.fromThreadRef}
    />
  );
}
