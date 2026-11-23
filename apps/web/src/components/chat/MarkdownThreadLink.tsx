import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { MessagesSquareIcon } from "lucide-react";
import {
  formatHostedThreadLink,
  guessThreadLinkRef,
  threadLinkCandidates,
  type ThreadLink,
} from "@t3tools/shared/threadLinks";
import { unknownThreadLinkLabel } from "@t3tools/shared/threadLinksCopy";
import { resolveLinkedThreadOpen } from "@t3tools/client-runtime/linked-thread";

import { configuredHostedAppUrl } from "../../hostedPairing";
import { useThreadRefs, useThreadShell } from "../../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { useSideThreadTrigger } from "../../hooks/useSideThreadTrigger";
import { openLinkedThreadRead } from "../../lib/sideChatPane";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadMention } from "../../loom/ThreadMention"; // loom: status-led mention

// loom: `ThreadMention` leads with the thread's live state instead of upstream's context chip,
// keeping the favicon only for a thread in another project than `fromThreadRef`'s.
/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  /** The thread the link is written in; a linked environment's thread can open in its right panel. */
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly link: ThreadLink;
  readonly label: string | null;
  readonly fromThreadRef?: ScopedThreadRef | undefined; // loom: the message's own thread
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const trigger = useSideThreadTrigger();
  const panelRef = props.threadRef ?? null;
  const candidates = threadLinkCandidates(props.link, props.environmentId);
  const writtenRef = candidates[0]!;
  const written = useThreadShell(writtenRef);
  const saved = useEnvironmentIdentities().some(
    (environment) => environment.environmentId === writtenRef.environmentId,
  );
  const connected = useConnectedEnvironmentIds().includes(writtenRef.environmentId);
  // A thread on a machine this client is not connected to still reads through the one that links to it.
  const linkedLabel = useLinkedEnvironments(
    connected || writtenRef.environmentId === props.environmentId ? null : props.environmentId,
  ).get(writtenRef.environmentId);
  // A shell cached from an earlier connection does not make the thread open there now.
  const linked =
    resolveLinkedThreadOpen({
      environmentId: writtenRef.environmentId,
      viaEnvironmentId: props.environmentId,
      own: saved ? { connected } : undefined,
      linked: linkedLabel !== undefined,
    }) === "linked";
  const reachable = saved && !linked;
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
    held === null && reachable // loom: no metadata query for a thread whose shell the client holds
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
  const missing = target === null && (settled || !reachable);
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
  if (linked && linkedLabel !== undefined) {
    const knownTitle = props.label ?? written?.title ?? null;
    const title = knownTitle ?? gt("Thread on {label}", { label: linkedLabel });
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextChip
              kind="thread"
              render={
                <button
                  type="button"
                  {...trigger(
                    (intent) =>
                      openLinkedThreadRead({
                        panelRef,
                        target: {
                          viaEnvironmentId: props.environmentId,
                          ...writtenRef,
                          label: linkedLabel,
                          title: knownTitle,
                        },
                        intent,
                        navigate,
                      }),
                    // Outside a thread there is no panel to read it in.
                    { panel: panelRef !== null },
                  )}
                />
              }
              aria-label={gt("Thread, {title}", { title })}
            >
              <MessagesSquareIcon />
              <ContextChipLabel>{title}</ContextChipLabel>
            </ContextChip>
          }
        />
        <TooltipPopup side="top">
          {gt("Read the thread on {label}", { label: linkedLabel })}
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (missing && resolved === null) {
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId, messages);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = resolved?.ref ?? writtenRef;
  const title = resolved?.metadata.title.trim() || props.label || gt("Thread");
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
