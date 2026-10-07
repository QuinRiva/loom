// loom: 3d-4 (DT-77) — the way out of the Workstream auto-open seed: a Settings
// row for `autoOpenWorkstreamPanel` (read by `useLoomRightPanelSurfaces`).
// Kept out of the upstream-owned `SettingsPanels.tsx`, which splices in the row,
// its dirty label and its restore-defaults key.
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";

const DEFAULT_AUTO_OPEN = DEFAULT_UNIFIED_SETTINGS.autoOpenWorkstreamPanel;

/** Spread into the restore-defaults patch. */
export const LOOM_AUTO_OPEN_RESTORE_DEFAULTS = { autoOpenWorkstreamPanel: DEFAULT_AUTO_OPEN };

/** Spread into the changed-settings labels. */
export const loomAutoOpenChangedLabels = (
  settings: Pick<UnifiedSettings, "autoOpenWorkstreamPanel">,
) => (settings.autoOpenWorkstreamPanel !== DEFAULT_AUTO_OPEN ? ["Auto-open workstream"] : []);

export function LoomAutoOpenSettingsRows({
  settings,
  updateSettings,
}: {
  readonly settings: Pick<UnifiedSettings, "autoOpenWorkstreamPanel">;
  readonly updateSettings: (patch: { autoOpenWorkstreamPanel: boolean }) => void;
}) {
  return (
    <SettingsRow
      title="Auto-open workstream"
      description="On a thread with sub-threads, open the Workstream board and Graph once when you first visit it."
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
  );
}
