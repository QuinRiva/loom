// loom: the context-viz experiment's three per-device switches (Settings → Behavior), rendered from
// `LoomAutoOpenSettingsRows` so the upstream `SettingsPanels.tsx` gains no line.
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
import { Switch } from "../../components/ui/switch";

const ROWS = [
  {
    key: "contextVizTimeline",
    title: "Context diagnostics: Timeline",
    description:
      "Beside each tool call and message in a pi thread, what it added to the context window, with a rail of where the window filled.",
  },
  {
    key: "contextVizComposition",
    title: "Context diagnostics: Composition",
    description:
      "A Context tab on pi threads listing what the window holds now, by category, tool and call.",
  },
  {
    key: "contextVizGrowth",
    title: "Context diagnostics: Growth",
    description:
      "In the Context tab, the window's size at every call and findings on what could have been left out.",
  },
] as const;

type ContextVizKey = (typeof ROWS)[number]["key"];
type ContextVizSettings = Pick<UnifiedSettings, ContextVizKey>;

/** Spread into the restore-defaults patch. */
export const CONTEXT_VIZ_RESTORE_DEFAULTS = Object.fromEntries(
  ROWS.map((row) => [row.key, DEFAULT_UNIFIED_SETTINGS[row.key]]),
) as ContextVizSettings;

/** Spread into the changed-settings labels. */
export const contextVizChangedLabels = (settings: ContextVizSettings) =>
  ROWS.filter((row) => settings[row.key] !== DEFAULT_UNIFIED_SETTINGS[row.key]).map(
    (row) => row.title,
  );

export function ContextVizSettingsRows({
  settings,
  updateSettings,
}: {
  readonly settings: ContextVizSettings;
  readonly updateSettings: (patch: Partial<ContextVizSettings>) => void;
}) {
  return ROWS.map((row) => (
    <SettingsRow
      key={row.key}
      title={row.title}
      description={row.description}
      resetAction={
        settings[row.key] !== DEFAULT_UNIFIED_SETTINGS[row.key] ? (
          <SettingResetButton
            label={row.title.toLowerCase()}
            onClick={() => updateSettings({ [row.key]: DEFAULT_UNIFIED_SETTINGS[row.key] })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings[row.key]}
          onCheckedChange={(checked) => updateSettings({ [row.key]: Boolean(checked) })}
          aria-label={row.title}
        />
      }
    />
  ));
}
