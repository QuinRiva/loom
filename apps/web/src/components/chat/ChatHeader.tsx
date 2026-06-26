import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo, useEffect, useState, type ReactNode } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { type LineageSegment } from "../../threadRouteLineage";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CornerLeftUpIcon,
  PanelBottomIcon,
  PanelRightIcon,
  TargetIcon,
} from "lucide-react";
import { countGoalTasks, useGoalById } from "../../goals/goalState";
import type { GoalShell } from "../../types";
import { readEnvironmentApi } from "../../environmentApi";
import { cn, newCommandId } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { shortcutLabelForCommand } from "../../keybindings";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  goalId: string | null;
  threadLineage: ReadonlyArray<LineageSegment>;
  threadRole: string | null;
  onNavigateToThread: (threadId: ThreadId) => void;
  gitCwd: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

function GoalHeaderSection({
  goalId,
  environmentId,
}: {
  goalId: string;
  environmentId: EnvironmentId;
}) {
  const goal = useGoalById(goalId);

  if (!goal) {
    return (
      <span className="shrink-0 truncate rounded-md border border-dashed border-border/70 px-2 py-0.5 text-xs text-muted-foreground/70">
        Missing goal: {goalId}
      </span>
    );
  }
  return <GoalHeaderBody goal={goal} environmentId={environmentId} />;
}

// Editable goal surface: the interpreted goal title/description are edit-in-place
// controlled inputs that commit via `goal.meta.update` (no Approve button — an
// untouched goal simply keeps its auto-created interpretation).
function GoalHeaderBody({
  goal,
  environmentId,
}: {
  goal: GoalShell;
  environmentId: EnvironmentId;
}) {
  const [expanded, setExpanded] = useState(false);
  const [titleDraft, setTitleDraft] = useState(goal.title);
  const [descriptionDraft, setDescriptionDraft] = useState(goal.description);
  useEffect(() => setTitleDraft(goal.title), [goal.title]);
  useEffect(() => setDescriptionDraft(goal.description), [goal.description]);
  const progress = countGoalTasks(goal.tasks);

  const dispatchGoalMeta = (fields: { title?: string; description?: string }) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    void api.orchestration.dispatchCommand({
      type: "goal.meta.update",
      commandId: newCommandId(),
      goalId: goal.id,
      ...fields,
    });
  };

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next.length === 0) {
      setTitleDraft(goal.title);
      return;
    }
    if (next !== goal.title) dispatchGoalMeta({ title: next });
  };
  const commitDescription = () => {
    if (descriptionDraft !== goal.description) dispatchGoalMeta({ description: descriptionDraft });
  };

  return (
    <div
      className={cn(
        "flex min-w-0 gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground",
        expanded ? "max-w-md flex-col" : "max-w-56 items-center",
      )}
    >
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <TargetIcon className="size-3.5 shrink-0" />
        <input
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setTitleDraft(goal.title);
              event.currentTarget.blur();
            }
          }}
          aria-label="Goal title"
          title={goal.title || goal.slug}
          className="min-w-0 flex-1 truncate bg-transparent font-medium text-foreground outline-none focus:rounded-sm focus:bg-accent focus:px-1"
        />
        {progress.total > 0 ? (
          <span className="shrink-0 tabular-nums text-muted-foreground/60">
            {progress.done}/{progress.total}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse goal" : "Expand goal"}
          className="shrink-0 text-muted-foreground/55 hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn("size-3 transition-transform", expanded ? "rotate-180" : "")}
          />
        </button>
      </div>
      {expanded ? (
        <textarea
          value={descriptionDraft}
          onChange={(event) => setDescriptionDraft(event.target.value)}
          onBlur={commitDescription}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDescriptionDraft(goal.description);
              event.currentTarget.blur();
            }
          }}
          aria-label="Goal description"
          rows={3}
          placeholder={"Describe this goal\u2026"}
          className="w-full resize-none rounded-sm bg-transparent leading-relaxed text-foreground/90 outline-none focus:bg-accent focus:px-1"
        />
      ) : null}
    </div>
  );
}

const MAX_VISIBLE_LINEAGE_SEGMENTS = 3;

function LineageSegmentChip({
  segment,
  isRoot,
  onNavigate,
}: {
  segment: LineageSegment;
  isRoot: boolean;
  onNavigate: (threadId: ThreadId) => void;
}) {
  if (segment.missing) {
    return (
      <span className="shrink-0 truncate rounded-md border border-dashed border-border/70 px-2 py-0.5 text-xs text-muted-foreground/70">
        parent unavailable
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => onNavigate(segment.threadId)}
            className={cn(
              "flex min-w-0 items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
              segment.archived ? "opacity-60" : "",
            )}
          >
            {isRoot ? (
              <span className="shrink-0 font-medium">Orchestrator</span>
            ) : (
              <span className="min-w-0 max-w-32 truncate">{segment.title}</span>
            )}
          </button>
        }
      />
      <TooltipPopup side="top">
        {isRoot ? `Orchestrator \u00b7 ${segment.title}` : segment.title}
      </TooltipPopup>
    </Tooltip>
  );
}

function ThreadLineageBreadcrumb({
  lineage,
  role,
  onNavigateToThread,
}: {
  lineage: ReadonlyArray<LineageSegment>;
  role: string | null;
  onNavigateToThread: (threadId: ThreadId) => void;
}) {
  if (lineage.length === 0) {
    return null;
  }

  const elide = lineage.length > MAX_VISIBLE_LINEAGE_SEGMENTS;
  const visible = elide ? [lineage[0]!, lineage[lineage.length - 1]!] : lineage;
  const hiddenTitles = elide ? lineage.slice(1, -1).map((segment) => segment.title) : [];

  const separator = (key: string) => (
    <ChevronRightIcon key={key} className="size-3 shrink-0 text-muted-foreground/55" />
  );

  const nodes: ReactNode[] = [];
  visible.forEach((segment, index) => {
    if (nodes.length > 0) {
      nodes.push(separator(`sep-${segment.threadId}`));
    }
    nodes.push(
      <LineageSegmentChip
        key={segment.threadId}
        segment={segment}
        isRoot={segment.isRoot}
        onNavigate={onNavigateToThread}
      />,
    );
    if (elide && index === 0) {
      nodes.push(separator("sep-ellipsis"));
      nodes.push(
        <Tooltip key="lineage-ellipsis">
          <TooltipTrigger
            render={
              <span className="shrink-0 px-1 text-xs text-muted-foreground/70">{"\u2026"}</span>
            }
          />
          <TooltipPopup side="top">{hiddenTitles.join(" \u203a ")}</TooltipPopup>
        </Tooltip>,
      );
    }
  });

  return (
    <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
      <CornerLeftUpIcon className="size-3.5 shrink-0" />
      {nodes}
      {separator("sep-role")}
      <span className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
        {role?.trim() || "sub-thread"}
      </span>
    </span>
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  rightPanelAvailable,
  rightPanelOpen,
  goalId,
  threadLineage,
  threadRole,
  onNavigateToThread,
  gitCwd,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleRightPanel,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const terminalShortcutLabel = shortcutLabelForCommand(keybindings, "terminal.toggle");
  const rightPanelShortcutLabel = shortcutLabelForCommand(keybindings, "rightPanel.toggle");

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2 overflow-hidden sm:flex-1 sm:flex-nowrap sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 basis-40 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
        <ThreadLineageBreadcrumb
          lineage={threadLineage}
          role={threadRole}
          onNavigateToThread={onNavigateToThread}
        />
        {goalId ? (
          <GoalHeaderSection goalId={goalId} environmentId={activeThreadEnvironmentId} />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-start gap-2 sm:shrink-0 sm:justify-end @3xl/header-actions:gap-3">
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="ghost"
                size="xs"
                disabled={!terminalAvailable}
              >
                <PanelBottomIcon className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={rightPanelOpen}
                onPressedChange={onToggleRightPanel}
                aria-label="Toggle right panel"
                variant="ghost"
                size="xs"
                disabled={!rightPanelAvailable}
              >
                <PanelRightIcon className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {rightPanelAvailable
              ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
              : "Right panel is unavailable"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
