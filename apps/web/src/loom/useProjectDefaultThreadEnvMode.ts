import type { EnvironmentId, ThreadEnvMode } from "@t3tools/contracts";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isDefaultThreadEnvModeSettled,
  resolveDefaultThreadEnvMode,
} from "@t3tools/shared/threadEnvMode";

import { useT3ProjectFileState } from "~/hooks/useT3ProjectFileScripts";

/**
 * The env mode a fresh draft of this project starts in — the render-time
 * counterpart of `resolveNewThreadDefaultEnvMode` (project setting > t3.json >
 * global). Null when `workspaceRoot` is null (disabled) or while t3.json is
 * still loading, so a caller never seeds a provisional default.
 */
export function useProjectDefaultThreadEnvMode(
  environmentId: EnvironmentId,
  workspaceRoot: string | null,
  projectSettings: ResolvedProjectSettings,
): ThreadEnvMode | null {
  const projectSetting =
    projectSettings.sources.defaultThreadEnvMode === "project"
      ? projectSettings.settings.defaultThreadEnvMode
      : undefined;
  const projectFile = useT3ProjectFileState(
    environmentId,
    projectSetting == null ? workspaceRoot : null,
  );
  const settled = isDefaultThreadEnvModeSettled({
    explicitMode: undefined,
    projectSetting,
    projectFilePending: projectFile.status === "loading",
  });
  return workspaceRoot === null || !settled
    ? null
    : resolveDefaultThreadEnvMode({
        projectSetting,
        projectFile: projectFile.file?.defaultThreadEnvMode,
        globalDefault: projectSettings.settings.defaultThreadEnvMode,
      });
}
