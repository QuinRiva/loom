import type { OrchestrationThreadSearchMatch } from "@t3tools/contracts"; // loom: thread search sources
import { THREAD_SEARCH_SOURCE_LABEL, threadSearchHighlightPattern } from "../loom/threadSearch"; // loom

// loom: highlights every query word, not the whole query — content hits are
// stemmed or semantic, so the literal query rarely appears in the snippet.
function HighlightedSearchText(props: { text: string; query: string }) {
  const pattern = threadSearchHighlightPattern(props.query);
  if (pattern === null) return props.text;
  // split() with a capturing pattern alternates plain and matched parts.
  return props.text.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <mark className="bg-transparent font-semibold text-foreground" key={index}>
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export function ThreadSearchMatchExcerpt(props: {
  // loom: every indexed text unit, plus the sub-thread that produced the hit
  match: Pick<OrchestrationThreadSearchMatch, "source" | "snippet" | "matchedThreadTitle"> & {
    readonly query: string;
  };
}) {
  const isUser = props.match.source === "user";
  // loom: a title hit's snippet IS the title — the root's is already the row's
  // own title, and a sub-thread's needs only the "Sub-thread:" prefix (as on mobile).
  const titleHit = props.match.source === "title";
  if (titleHit && props.match.matchedThreadTitle === null) return null;
  return (
    <span className="truncate text-xs text-muted-foreground/85">
      {/* loom: a hit inside a sub-thread credits the root but names the sub-thread */}
      {props.match.matchedThreadTitle !== null ? (
        <span className="text-muted-foreground/70">
          {titleHit ? "Sub-thread:" : `Sub-thread: ${props.match.matchedThreadTitle} ·`}{" "}
        </span>
      ) : null}
      {titleHit ? null : (
        <span className={isUser ? "text-info-foreground" : "text-success-foreground"}>
          {THREAD_SEARCH_SOURCE_LABEL[props.match.source]}{" "}
        </span>
      )}
      <HighlightedSearchText text={props.match.snippet} query={props.match.query} />
    </span>
  );
}
