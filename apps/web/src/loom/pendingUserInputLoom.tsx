/**
 * loom: 3d-4 (DT-36, P3-27) — Loom's additions to upstream's RuntimeRequest
 * panel (`components/chat/ComposerPendingUserInputPanel.tsx`), so a question
 * read cold is answerable: a markdown body whose paths are chat's file chips,
 * and "reply in chat instead", which sends the composer text as an ordinary
 * message (the server settles the set as superseded, 3a). Digit-select never
 * submitting is a guard inside the panel itself.
 *
 * ChatView hosts the request (it owns the send path and the markdown context);
 * the panel reads its host by request id, so ChatComposer — which sits between
 * them — carries no Loom props.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import ChatMarkdown from "../components/ChatMarkdown";

export interface LoomPendingInputHost {
  /** Where the body's relative paths resolve and which panel their chips open in. */
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
  /** Sends the composer's text as a plain chat message. */
  readonly onReplyInChat: () => void;
}

const useHosts = create<{ readonly hosts: Readonly<Record<string, LoomPendingInputHost>> }>(() => ({
  hosts: {},
}));

/** ChatView: host the active request. The reply callback is read through a ref. */
export function useHostLoomPendingInput(requestId: string | null, host: LoomPendingInputHost) {
  const replyRef = useRef(host.onReplyInChat);
  replyRef.current = host.onReplyInChat;
  const { cwd, threadRef } = host;
  useEffect(() => {
    if (requestId === null) return;
    const entry: LoomPendingInputHost = { cwd, threadRef, onReplyInChat: () => replyRef.current() };
    useHosts.setState((state) => ({ hosts: { ...state.hosts, [requestId]: entry } }));
    return () =>
      useHosts.setState((state) => {
        const { [requestId]: _removed, ...hosts } = state.hosts;
        return { hosts };
      });
  }, [cwd, requestId, threadRef]);
}

/** The panel: its request's host, or undefined (preview harness, unhosted surfaces). */
export function useLoomPendingInputHost(requestId: string): LoomPendingInputHost | undefined {
  return useHosts((state) => state.hosts[requestId]);
}

/** Test/preview seam: host a request without a ChatView. */
export const hostLoomPendingInputForPreview = (requestId: string, host: LoomPendingInputHost) =>
  useHosts.setState((state) => ({ hosts: { ...state.hosts, [requestId]: host } }));

export function PendingQuestionBody({
  text,
  host,
}: {
  readonly text: string;
  readonly host: LoomPendingInputHost | undefined;
}) {
  return (
    <ChatMarkdown
      text={text}
      cwd={host?.cwd}
      threadRef={host?.threadRef}
      className="text-sm text-foreground/85"
      lineBreaks
    />
  );
}

/** Answer the set in prose: the composer's text goes out as an ordinary message. */
export function ReplyInChatInsteadButton({
  hasText,
  questionCount,
  disabled,
  onReply,
}: {
  readonly hasText: boolean;
  readonly questionCount: number;
  readonly disabled: boolean;
  readonly onReply: () => void;
}) {
  const scope = questionCount > 1 ? `all ${questionCount} questions` : "the question";
  return (
    <div className="mt-2 flex items-center justify-end gap-2 text-2xs text-muted-foreground">
      <span>
        {hasText
          ? `Sends the composer text as a message that settles ${scope}`
          : "Type in the composer to reply in your own words"}
      </span>
      <button
        type="button"
        disabled={disabled || !hasText}
        onClick={onReply}
        data-pending-user-input-reply-in-chat
        className="shrink-0 rounded-md border border-border/60 px-2 py-1 transition-colors hover:bg-muted/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        Reply in chat instead ↩
      </button>
    </div>
  );
}
