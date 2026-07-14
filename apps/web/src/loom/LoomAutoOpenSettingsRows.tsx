// Loom-owned settings rows for the durable one-shot auto-open toggles (plan
// W1). Kept out of the upstream-owned `SettingsPanels.tsx` so upstream merges
// touch only splice points: the row markup, the dirty-label enumeration, and
// the restore-defaults patch each integrate through the small exports here.
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";

type AutoOpenPatch = Partial<
  Pick<UnifiedSettings, "autoOpenGoalTasksPanel" | "autoOpenWorkstreamPanel">
>;

// Restore-defaults patch: spread into the upstream `restoreDefaults` update.
export const LOOM_AUTO_OPEN_RESTORE_DEFAULTS = {
  autoOpenGoalTasksPanel: DEFAULT_UNIFIED_SETTINGS.autoOpenGoalTasksPanel,
  autoOpenWorkstreamPanel: DEFAULT_UNIFIED_SETTINGS.autoOpenWorkstreamPanel,
} as const;

// Dirty labels for the "changed settings" summary/enumeration.
export function loomAutoOpenChangedLabels(settings: UnifiedSettings): string[] {
  return [
    ...(settings.autoOpenGoalTasksPanel !== DEFAULT_UNIFIED_SETTINGS.autoOpenGoalTasksPanel
      ? ["Auto-open goal tasks"]
      : []),
    ...(settings.autoOpenWorkstreamPanel !== DEFAULT_UNIFIED_SETTINGS.autoOpenWorkstreamPanel
      ? ["Auto-open workstream"]
      : []),
  ];
}

export function LoomAutoOpenSettingsRows({
  settings,
  updateSettings,
}: {
  settings: UnifiedSettings;
  updateSettings: (patch: AutoOpenPatch) => void;
}) {
  return (
    <>
      <SettingsRow
        title="Auto-open goal tasks"
        description="On a goal-bound thread, open the Goal Tasks panel once when you first visit it."
        resetAction={
          settings.autoOpenGoalTasksPanel !== DEFAULT_UNIFIED_SETTINGS.autoOpenGoalTasksPanel ? (
            <SettingResetButton
              label="auto-open goal tasks"
              onClick={() =>
                updateSettings({
                  autoOpenGoalTasksPanel: DEFAULT_UNIFIED_SETTINGS.autoOpenGoalTasksPanel,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.autoOpenGoalTasksPanel}
            onCheckedChange={(checked) =>
              updateSettings({ autoOpenGoalTasksPanel: Boolean(checked) })
            }
            aria-label="Open the goal tasks panel automatically"
          />
        }
      />

      <SettingsRow
        title="Auto-open workstream"
        description="On a thread that has a parent or sub-threads, open the Workstream panel once when you first visit it."
        resetAction={
          settings.autoOpenWorkstreamPanel !== DEFAULT_UNIFIED_SETTINGS.autoOpenWorkstreamPanel ? (
            <SettingResetButton
              label="auto-open workstream"
              onClick={() =>
                updateSettings({
                  autoOpenWorkstreamPanel: DEFAULT_UNIFIED_SETTINGS.autoOpenWorkstreamPanel,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.autoOpenWorkstreamPanel}
            onCheckedChange={(checked) =>
              updateSettings({ autoOpenWorkstreamPanel: Boolean(checked) })
            }
            aria-label="Open the workstream panel automatically"
          />
        }
      />
    </>
  );
}
