/**
 * loom: the Diff panel's "Written by" row and the author chips on each file's header
 * (plans/diff-author-query/plan.mdx §4). A row chip narrows the diff to that author's files.
 */
import { UsersRoundIcon } from "lucide-react";

import { Toggle } from "../../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { AUTHOR_COLOURS, NEUTRAL_AUTHOR_COLOUR, type AuthorGroup } from "./authorship";
import type { useLoomAuthorship } from "./useLoomAuthorship";

type LoomAuthorship = ReturnType<typeof useLoomAuthorship>;

const colourOf = (group: AuthorGroup) =>
  group.slot === null ? NEUTRAL_AUTHOR_COLOUR : AUTHOR_COLOURS[group.slot];

function AuthorDot({ group }: { group: AuthorGroup }) {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full"
      style={
        group.kind === "uncommitted"
          ? { border: `1.5px dashed ${colourOf(group)}` }
          : { backgroundColor: colourOf(group) }
      }
    />
  );
}

/** The toolbar's Authors toggle, beside Hide test files. */
export function AuthorshipToggle({ authors }: { authors: LoomAuthorship }) {
  if (!authors.eligible) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={authors.shown ? "Hide authors" : "Show authors"}
            variant="ghost"
            size="sm"
            pressed={authors.shown}
            onPressedChange={(pressed) => authors.setOff(!pressed)}
          />
        }
      >
        <UsersRoundIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {authors.shown ? "Hide who wrote each change" : "Show who wrote each change"}
      </TooltipPopup>
    </Tooltip>
  );
}

/** `paths` are the files the shown diff lists: a "Since your message" view lists fewer than the branch. */
export function AuthorshipLegend({
  authors,
  paths,
}: {
  authors: LoomAuthorship;
  paths: ReadonlySet<string>;
}) {
  if (!authors.shown) return null;
  const { authorship } = authors;
  const groups = (authorship?.groups ?? []).flatMap((group) => {
    const files = [...group.files].filter((path) => paths.has(path)).length;
    return files > 0 ? [{ group, files }] : [];
  });
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 px-3 text-2xs text-muted-foreground">
      <span className="shrink-0 pe-1">Written by</span>
      {authorship === null ? (
        <span className="truncate">
          {authors.error
            ? `Authors unavailable: ${authors.error}`
            : "Finding who wrote these lines…"}
        </span>
      ) : groups.length === 0 ? (
        <span className="truncate">no added lines here to attribute</span>
      ) : (
        groups.map(({ group, files }) => (
          <Toggle
            key={group.key}
            variant="pill"
            size="xs"
            pressed={authors.filter === group.key}
            onPressedChange={(pressed) => authors.setFilter(pressed ? group.key : null)}
            aria-label={`Show only ${group.label}'s changes`}
          >
            <AuthorDot group={group} />
            <span className="max-w-48 truncate">{group.label}</span>
            <span className="tabular-nums opacity-70">{files}</span>
          </Toggle>
        ))
      )}
      {authorship?.incomplete ? (
        <span className="shrink-0 ps-1">· partial: some files were not checked</span>
      ) : null}
    </div>
  );
}

/** The authors with lines in one file; the only label for a hunk that starts at line 1. */
export function AuthorshipFileChips({ authors, path }: { authors: LoomAuthorship; path: string }) {
  const groups = authors.authorship?.groups.filter((group) => group.files.has(path)) ?? [];
  if (groups.length === 0) return null;
  return (
    <span className="ms-1 inline-flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
      {groups.slice(0, 2).map((group) => (
        <span key={group.key} className="inline-flex min-w-0 items-center gap-1">
          <AuthorDot group={group} />
          <span className="max-w-32 truncate">{group.label}</span>
        </span>
      ))}
      {groups.length > 2 ? <span>+{groups.length - 2}</span> : null}
    </span>
  );
}
