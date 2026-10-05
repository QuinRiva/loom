import type { EnvironmentId, ThreadEnvMode } from "@t3tools/contracts";
import {
  resolveProjectFileBackedSetting,
  type ResolvedProjectSettings,
} from "@t3tools/shared/projectSettings";

import { useT3ProjectFileState } from "~/hooks/useT3ProjectFileScripts";

/**
 * The env mode a fresh draft of this project starts in — the render-time
 * counterpart of `resolveNewThreadDefaultEnvMode`, on upstream's resolver chain
 * (project > environment > checked-in t3.json > built-in). Null when
 * `workspaceRoot` is null (disabled) or while a deciding t3.json is still
 * loading, so a caller never seeds a provisional default.
 */
export function useProjectDefaultThreadEnvMode(
  environmentId: EnvironmentId,
  workspaceRoot: string | null,
  projectSettings: ResolvedProjectSettings,
): ThreadEnvMode | null {
  const setting = projectSettings.settings.defaultThreadEnvMode;
  const projectFile = useT3ProjectFileState(environmentId, setting === null ? workspaceRoot : null);
  return workspaceRoot === null || (setting === null && projectFile.status === "loading")
    ? null
    : resolveProjectFileBackedSetting("defaultThreadEnvMode", setting, projectFile.file).value;
}
