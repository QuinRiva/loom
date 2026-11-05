// loom: 3d-4 (DT-77) — the way out of the Workstream auto-open seed: a Settings
// row for `autoOpenWorkstreamPanel` (read by `useLoomRightPanelSurfaces`).
// Kept out of the upstream-owned `SettingsPanels.tsx`, which splices in the row,
// its dirty label and its restore-defaults key.
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import {
  CONTEXT_VIZ_RESTORE_DEFAULTS,
  contextVizChangedLabels,
  ContextVizSettingsRows,
} from "./context-viz/ContextVizSettingsRows";

const DEFAULT_AUTO_OPEN = DEFAULT_UNIFIED_SETTINGS.autoOpenWorkstreamPanel;

/** Spread into the restore-defaults patch. */
export const LOOM_AUTO_OPEN_RESTORE_DEFAULTS = {
  autoOpenWorkstreamPanel: DEFAULT_AUTO_OPEN,
  ...CONTEXT_VIZ_RESTORE_DEFAULTS,
};

type LoomBehaviorSettings = Pick<
  UnifiedSettings,
  "autoOpenWorkstreamPanel" | "contextVizTimeline" | "contextVizComposition" | "contextVizGrowth"
>;

/** Spread into the changed-settings labels. */
export const loomAutoOpenChangedLabels = (settings: LoomBehaviorSettings) => [
  ...(settings.autoOpenWorkstreamPanel !== DEFAULT_AUTO_OPEN ? ["Auto-open workstream"] : []),
  ...contextVizChangedLabels(settings),
];

export function LoomAutoOpenSettingsRows({
  settings,
  updateSettings,
}: {
  readonly settings: LoomBehaviorSettings;
  readonly updateSettings: (patch: Partial<LoomBehaviorSettings>) => void;
}) {
  return (
    <>
      <SettingsRow
        title="Auto-open workstream"
        description={
          <span className="block max-w-sm">
            On a thread with sub-threads, open its Workstream graph once when you first visit it.
          </span>
        }
        resetAction={
          settings.autoOpenWorkstreamPanel !== DEFAULT_AUTO_OPEN ? (
            <SettingResetButton
              label="auto-open workstream"
              onClick={() => updateSettings({ autoOpenWorkstreamPanel: DEFAULT_AUTO_OPEN })}
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
      <ContextVizSettingsRows settings={settings} updateSettings={updateSettings} />
    </>
  );
}
