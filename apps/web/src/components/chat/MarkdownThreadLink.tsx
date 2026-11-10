import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts"; // loom: ScopedThreadRef
import {
  formatHostedThreadLink,
  guessThreadLinkRef,
  threadLinkCandidates,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { configuredHostedAppUrl } from "../../hostedPairing";
import { useThreadRefs, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";
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
  const candidates = threadLinkCandidates(props.link, props.environmentId);
  const writtenRef = candidates[0]!;
  const written = useThreadShell(writtenRef);
  // loom: a percent-encoded link to a thread this client holds still reads its shell (DL-1818).
  const decodedRef = candidates[1] ?? null;
  const decoded = useThreadShell(written === null ? decodedRef : null);
  const held =
    written !== null
      ? { ref: writtenRef, metadata: written }
      : decodedRef && decoded
        ? { ref: decodedRef, metadata: decoded }
        : null;
  const lookup = useEnvironmentQuery(
    held === null // loom: no metadata query for a thread whose shell the client holds
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId: writtenRef.environmentId,
          input: { threadIds: candidates.map((ref) => ref.threadId) },
        })
      : null,
  );
  const settled = lookup.isSuccess && !lookup.isPending;
  const target =
    held ?? // loom: written or decoded shell
    candidates.flatMap((ref) => {
      const metadata = lookup.data?.[ref.threadId];
      return metadata ? [{ ref, metadata }] : [];
    })[0] ??
    null;
  const missing = target === null && settled;
  const guess = missing && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remoteRef = guess
    ? guessThreadLinkRef(
        props.link,
        refs.filter((ref) => ref.environmentId !== writtenRef.environmentId),
      )
    : null;
  const remote = useThreadShell(remoteRef);
  const resolved = target ?? (remoteRef && remote ? { ref: remoteRef, metadata: remote } : null);
  if (missing && resolved === null) {
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = resolved?.ref ?? writtenRef;
  const title = resolved?.metadata.title.trim() || props.label || "Thread";
  // loom: a thread this client holds a shell for reads as Loom's status-led mention.
  const shell = held?.metadata ?? remote;
  if (shell !== null) {
    return (
      <ThreadMention
        environmentId={shell.environmentId}
        threadId={shell.id}
        title={title}
        thread={shell}
        fromThreadRef={props.fromThreadRef}
      />
    );
  }
  return (
    <ThreadContextChip
      record={{ ...ref, title }}
      projectId={resolved?.metadata.projectId ?? null}
      copyMarkdown={formatHostedThreadLink(ref, title, configuredHostedAppUrl())}
    />
  );
}
