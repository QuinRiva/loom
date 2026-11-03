/**
 * loom: additions to upstream's RuntimeRequest panel so a question read cold is answerable: its
 * one-line summary and age, also read by the open-questions rail.
 */
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { useNowMinute } from "../hooks/useNowMinute";
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
