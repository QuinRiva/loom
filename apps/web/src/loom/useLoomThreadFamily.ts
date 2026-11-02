import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadFamilies } from "../state/threads";

/**
 * Keeps the workstream under `rootThreadId` in the shells while the caller shows it. The cold
 * shell leaves out children of settled and archived Loom roots (DL-1404), so the Workstream
 * panel, tab and rollup badge of a finished workstream read its family from here (DL-1706).
 */
export function useLoomThreadFamily(
  environmentId: EnvironmentId | null,
  rootThreadId: ThreadId | null,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the workstream family into the shared thread registry while the caller shows it, and releases it on leave
  useEffect(() => {
    if (environmentId === null || rootThreadId === null) return;
    return threadFamilies.mount(appAtomRegistry, environmentId, rootThreadId);
  }, [environmentId, rootThreadId]);
}
