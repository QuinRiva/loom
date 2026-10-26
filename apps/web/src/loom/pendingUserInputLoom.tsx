/**
 * loom: additions to upstream's RuntimeRequest panel so a question read cold is answerable: its
 * one-line summary and age, and "reply in chat instead", sending the composer text as a message (the
 * server settles the set as superseded). ChatView hosts the request; the panel reads its host by
 * request id, so ChatComposer between them carries no Loom props.
 */
import type { Nodes } from "mdast";
import { useEffect } from "react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { create } from "zustand";

import { useNowMinute } from "../hooks/useNowMinute";
import { useStableCallback } from "../hooks/useStableCallback";
import { formatElapsedDurationLabel } from "../timestampFormat";

/**
 * S4 — a question's age on the shared minute clock: undefined when
 * unparseable, null under a minute, else "4m" / "3h" / "2d". The clock's value
 * feeds the label so the React Compiler cannot memoise it stale; minute
 * resolution, so it reads up to a minute low.
 */
function useMinuteAge(iso: string): string | null | undefined {
  const label = formatElapsedDurationLabel(iso, Date.parse(`${useNowMinute()}:00Z`));
  if (label === "") return undefined;
  return label === "just now" || label.endsWith("s") ? null : label;
}

/** The sidebar Input label's suffix: how long the question has waited ("· 3h"). */
export function PendingQuestionWaitAge({ since }: { since: string }) {
  const age = useMinuteAge(since);
  return age === undefined ? null : <span className="font-normal">· {age ?? "now"}</span>;
}

/** "asked 3h ago" in the question panel's header. */
export function PendingQuestionAge({ createdAt }: { createdAt: string }) {
  const age = useMinuteAge(createdAt);
  return age === undefined ? null : (
    <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">
      asked {age === null ? "just now" : `${age} ago`}
    </span>
  );
}

export interface LoomPendingInputHost {
  /** Sends the composer's text as a plain chat message. */
  readonly onReplyInChat: () => void;
}

const useHosts = create<{ readonly hosts: Readonly<Record<string, LoomPendingInputHost>> }>(() => ({
  hosts: {},
}));

const withoutHost = (hosts: Readonly<Record<string, LoomPendingInputHost>>, requestId: string) => {
  const { [requestId]: _removed, ...rest } = hosts;
  return rest;
};

/** ChatView: host the active request. The reply callback keeps one identity. */
export function useHostLoomPendingInput(requestId: string | null, host: LoomPendingInputHost) {
  const onReplyInChat = useStableCallback(host.onReplyInChat);
  useEffect(() => {
    if (requestId === null) return;
    const entry: LoomPendingInputHost = { onReplyInChat };
    useHosts.setState((state) => ({ hosts: { ...state.hosts, [requestId]: entry } }));
    return () => useHosts.setState((state) => ({ hosts: withoutHost(state.hosts, requestId) }));
  }, [requestId, onReplyInChat]);
}

/** The panel: its request's host, or undefined (preview harness, unhosted surfaces). */
export function useLoomPendingInputHost(requestId: string): LoomPendingInputHost | undefined {
  return useHosts((state) => state.hosts[requestId]);
}

/** Test/preview seam: host a request without a ChatView. */
export const hostLoomPendingInputForPreview = (requestId: string, host: LoomPendingInputHost) =>
  useHosts.setState((state) => ({ hosts: { ...state.hosts, [requestId]: host } }));

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const BLOCK_PARENTS = new Set(["root", "list", "listItem", "blockquote", "table", "tableRow"]);
const plainText = (node: Nodes): string =>
  "value" in node
    ? node.value
    : node.type === "break"
      ? " "
      : "children" in node
        ? node.children.map(plainText).join(BLOCK_PARENTS.has(node.type) ? " " : "")
        : "";

/** The question as one line of plain text, for the collapsed panel's header. */
export const questionSummary = (markdown: string) =>
  plainText(markdownParser.parse(markdown)).replace(/\s+/g, " ").trim();

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
