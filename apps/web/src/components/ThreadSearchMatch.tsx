// loom: every indexed source, labelled; highlighting is per query token (the server stems)
import {
  threadSearchExcerptLabel,
  threadSearchHighlightParts,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import type { OrchestrationThreadSearchMatch } from "@t3tools/contracts";

function HighlightedSearchText(props: { text: string; query: string }) {
  // loom: per-token prefix highlight; a stemmed or semantic hit need not contain the query
  return threadSearchHighlightParts(props.text, props.query).map((part) =>
    part.highlighted ? (
      <mark className="bg-transparent font-semibold text-foreground" key={part.start}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

export function ThreadSearchMatchExcerpt(props: {
  // loom: every source, plus the sub-thread that produced the hit
  match: Pick<
    OrchestrationThreadSearchMatch,
    "source" | "snippet" | "matchedThreadId" | "matchedThreadTitle"
  > & { readonly query: string };
}) {
  // loom: a hit on the root's own title has no label; the row already shows the title
  const label = threadSearchExcerptLabel(props.match);
  if (label === null) return null;
  const isUser = props.match.source === "user";
  return (
    <span className="truncate text-xs text-muted-foreground/85">
      <span className={isUser ? "text-info-foreground" : "text-success-foreground"}>{label}</span>{" "}
      <HighlightedSearchText text={props.match.snippet} query={props.match.query} />
    </span>
  );
}
