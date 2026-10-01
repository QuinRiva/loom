import type { OrchestrationThreadSearchSource } from "@t3tools/contracts"; // loom: thread search sources

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function HighlightedSearchText(props: { text: string; query: string }) {
  const query = props.query.trim();
  if (query.length === 0) return props.text;

  const normalizedText = foldAsciiCase(props.text);
  const normalizedQuery = foldAsciiCase(query);
  const parts: Array<{
    readonly text: string;
    readonly highlighted: boolean;
    readonly start: number;
  }> = [];
  let cursor = 0;

  while (cursor < props.text.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
    if (matchIndex === -1) {
      parts.push({ text: props.text.slice(cursor), highlighted: false, start: cursor });
      break;
    }
    if (matchIndex > cursor) {
      parts.push({
        text: props.text.slice(cursor, matchIndex),
        highlighted: false,
        start: cursor,
      });
    }
    parts.push({
      text: props.text.slice(matchIndex, matchIndex + query.length),
      highlighted: true,
      start: matchIndex,
    });
    cursor = matchIndex + query.length;
  }

  return parts.map((part) =>
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
  match: {
    readonly source: OrchestrationThreadSearchSource; // loom: every indexed text unit
    readonly snippet: string;
    readonly query: string;
  };
}) {
  const isUser = props.match.source === "user";
  // loom: non-message sources are labelled by kind ("Brief:", "Report:", …).
  const label =
    props.match.source === "user"
      ? "You:"
      : props.match.source === "assistant"
        ? "Agent:"
        : `${props.match.source[0]!.toUpperCase()}${props.match.source.slice(1)}:`;
  return (
    <span className="truncate text-xs text-muted-foreground/85">
      <span className={isUser ? "text-blue-400" : "text-emerald-400"}>{label}</span>{" "}
      <HighlightedSearchText text={props.match.snippet} query={props.match.query} />
    </span>
  );
}
