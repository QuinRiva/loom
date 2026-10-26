import {
  findSearchTokenRanges,
  splitSearchText,
  type SearchMatchHint,
  type SearchRange,
} from "@t3tools/shared/paletteSearch";
// loom: every indexed source, labelled, and the sub-thread line
import {
  threadSearchExcerptLabel,
  threadSearchMatchedSubThreadTitle,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import type { OrchestrationThreadSearchMatch } from "@t3tools/contracts";

/** `text` with each range in semibold foreground. */
function HighlightedSearchText(props: { text: string; ranges: ReadonlyArray<SearchRange> }) {
  if (props.ranges.length === 0) return props.text;
  return splitSearchText(props.text, props.ranges).map((part) =>
    part.highlighted ? (
      <mark className="bg-transparent font-semibold text-foreground" key={part.start}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

/** Why a row matched when its title does not show it: the field and its match. */
export function SearchMatchHintLine(props: { hint: SearchMatchHint }) {
  return (
    <span className="truncate text-xs text-muted-foreground/85">
      <span className="text-muted-foreground/70">{props.hint.label}:</span>{" "}
      <HighlightedSearchText text={props.hint.text} ranges={props.hint.ranges} />
    </span>
  );
}

export function ThreadSearchMatchExcerpt(props: {
  // loom: every indexed source, plus the sub-thread that produced the hit
  match: Pick<
    OrchestrationThreadSearchMatch,
    "source" | "snippet" | "matchedThreadId" | "matchedThreadTitle"
  > & { readonly query: string };
}) {
  // loom: a hit on the root's own title has no label; the row already shows the title
  const label = threadSearchExcerptLabel(props.match);
  if (label === null) return null;
  const isUser = props.match.source === "user";
  // loom: the sub-thread gets its own line so its title never crowds out the matched words
  const subThreadTitle = threadSearchMatchedSubThreadTitle(props.match);
  return (
    <>
      <span className="truncate text-xs text-muted-foreground/85">
        <span className={isUser ? "text-info-foreground" : "text-success-foreground"}>{label}</span>{" "}
        <HighlightedSearchText
          text={props.match.snippet}
          ranges={findSearchTokenRanges(props.match.snippet, props.match.query)}
        />
      </span>
      {subThreadTitle === null ? null : (
        <span className="truncate text-xs text-muted-foreground/60">
          Sub-thread: {subThreadTitle}
        </span>
      )}
    </>
  );
}
