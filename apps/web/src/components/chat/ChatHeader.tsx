import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo, useState } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { ChevronDownIcon, PanelBottomIcon, PanelRightIcon, TargetIcon } from "lucide-react";
import { useGoalIndex } from "../../goals/goalIndex";
import { cn } from "~/lib/utils";
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
  goalSlug: string | null;
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

function GoalHeaderSection({ goalSlug }: { goalSlug: string }) {
  const [expanded, setExpanded] = useState(false);
  const goal = useGoalIndex().data?.find((entry) => entry.slug === goalSlug);

  if (!goal) {
    return (
      <span className="shrink-0 truncate rounded-md border border-dashed border-border/70 px-2 py-0.5 text-xs text-muted-foreground/70">
        Missing goal package: {goalSlug}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded((value) => !value)}
      aria-expanded={expanded}
      title={goal.title || goal.slug}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
        expanded ? "max-w-md" : "max-w-56",
      )}
    >
      <TargetIcon className="size-3.5 shrink-0" />
      {expanded ? (
        <span className="min-w-0 whitespace-pre-wrap text-left leading-relaxed">
          {goal.goalParagraph || goal.title || goal.slug}
        </span>
      ) : (
        <>
          <span className="min-w-0 truncate font-medium">{goal.title || goal.slug}</span>
          {goal.progress.total > 0 ? (
            <span className="shrink-0 tabular-nums text-muted-foreground/60">
              {goal.progress.done}/{goal.progress.total}
            </span>
          ) : null}
        </>
      )}
      <ChevronDownIcon
        className={cn(
          "size-3 shrink-0 text-muted-foreground/55 transition-transform",
          expanded ? "rotate-180" : "",
        )}
      />
    </button>
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
  goalSlug,
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
        {goalSlug ? <GoalHeaderSection goalSlug={goalSlug} /> : null}
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
