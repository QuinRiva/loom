/**
 * loom: the change-review controls the Files surface carries: the baseline chip shared by the Files
 * header and an opened file, and the header's row of baseline · Changed only · Repo code /
 * Everything. The baseline is the Diff panel's selection, so a pick here moves the Diff panel too.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { useDiffPanelStore } from "../../diffPanelStore";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/menu";
import { Toggle } from "../../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { LoomScopeMenuEntries, LoomSourcesMenuGroup } from "./LoomScopeMenuEntries";
import { useReviewBaselineStore } from "./reviewBaselineStore";
import type { LoomChangeMarks } from "./useLoomChangeMarks";

export function LoomBaselineChip({
  threadRef,
  marks,
}: {
  threadRef: ScopedThreadRef;
  marks: LoomChangeMarks;
}) {
  const showMarks = () => useReviewBaselineStore.getState().setMarksOff(false);
  const selectGitScope = (scope: "branch" | "unstaged") => {
    useReviewBaselineStore.getState().selectInterval(threadRef, null);
    useDiffPanelStore.getState().selectGitScope(threadRef, scope);
    showMarks();
  };
  const label = marks.marksOff ? "Change marks off" : marks.label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="xs" variant={marks.marksOff ? "ghost-muted" : "secondary"} />}
        className="min-w-0 max-w-full shrink"
        aria-label={`Change baseline: ${label}`}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => selectGitScope("branch")}>
          Changes (branch)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => selectGitScope("unstaged")}>Uncommitted</DropdownMenuItem>
        <LoomScopeMenuEntries
          threadRef={threadRef}
          active={marks.scope === "interval"}
          showSources={false}
          onSelect={showMarks}
        />
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={!marks.marksOff}
          onCheckedChange={(checked) => useReviewBaselineStore.getState().setMarksOff(!checked)}
        >
          Show change marks
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Files header's second row; "Changed only" collapses the tree to marked files. */
export function LoomFilesReviewBar({
  threadRef,
  marks,
}: {
  threadRef: ScopedThreadRef;
  marks: LoomChangeMarks;
}) {
  const changedOnly = useReviewBaselineStore((state) => state.changedOnly);
  const sources = useReviewBaselineStore((state) => state.sources);
  const count = marks.files.size;
  const sourcesActive = marks.scope === "interval" && !marks.marksOff;
  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 px-2 pb-1">
      <LoomBaselineChip threadRef={threadRef} marks={marks} />
      {/* The filter and its sources wrap as one, so a narrow explorer never strands a lone chip. */}
      <div className="flex shrink-0 items-center gap-1">
        <Toggle
          size="xs"
          variant="outline"
          className="shrink-0"
          pressed={changedOnly && !marks.marksOff}
          disabled={marks.marksOff}
          onPressedChange={(pressed) =>
            useReviewBaselineStore.getState().setChangedOnly(Boolean(pressed))
          }
          aria-label="Show only changed files"
        >
          Changed only{marks.baseline ? ` · ${count}` : ""}
        </Toggle>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={<Button size="xs" variant="ghost-muted" />}
                  className="shrink-0"
                  disabled={!sourcesActive}
                  aria-label={`Sources: ${sources === "repo" ? "Repo code" : "Everything"}`}
                />
              }
            >
              {sources === "repo" ? "Repo code" : "Everything"}
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {sourcesActive
                ? "Repo code, or also nested repositories and artefact folders"
                : "Applies to Since your message and Earlier; git comparisons cover the repo only"}
            </TooltipPopup>
          </Tooltip>
          <DropdownMenuContent align="start">
            <LoomSourcesMenuGroup active={sourcesActive} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
