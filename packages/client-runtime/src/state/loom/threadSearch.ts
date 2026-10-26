import type { OrchestrationThreadSearchSource } from "@t3tools/contracts";

import type { EnvironmentThreadSearchMatch } from "../threadSearch.ts";

const SOURCE_LABEL = {
  user: "You",
  assistant: "Agent",
  title: "Title",
  purpose: "Purpose",
  brief: "Brief",
  goal: "Goal",
  task: "Task",
  report: "Report",
} satisfies Record<OrchestrationThreadSearchSource, string>;

/**
 * The kind of text an excerpt matched, or null when there is nothing to add:
 * a hit on the root's own title, which the row already shows. A sub-thread
 * hit names its sub-thread apart (`threadSearchMatchedSubThreadTitle`), so the
 * snippet keeps the excerpt line.
 */
export function threadSearchExcerptLabel(
  match: Pick<EnvironmentThreadSearchMatch, "source" | "matchedThreadId">,
): string | null {
  if (match.source !== "title") return `${SOURCE_LABEL[match.source]}:`;
  // A sub-thread title hit: the snippet is that title.
  return match.matchedThreadId === null ? null : "Sub-thread:";
}

/** The sub-thread a non-title hit came from, for a line of its own; null for a root's own text. */
export function threadSearchMatchedSubThreadTitle(
  match: Pick<EnvironmentThreadSearchMatch, "source" | "matchedThreadId" | "matchedThreadTitle">,
): string | null {
  return match.matchedThreadId === null || match.source === "title"
    ? null
    : (match.matchedThreadTitle ?? "Untitled");
}

/**
 * Content hits on roots the client holds no shell for. Archived roots are the
 * only such roots (the shell stream drops them); a live root missing from the
 * list was filtered out by the list itself and stays out.
 */
export function shelllessArchivedMatches(input: {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isInScope: (match: EnvironmentThreadSearchMatch) => boolean;
}): EnvironmentThreadSearchMatch[] {
  return input.matches.filter((match) => match.archivedAt !== null && input.isInScope(match));
}
