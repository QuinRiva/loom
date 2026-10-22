import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { downloadMedia } from "~/components/media/mediaContent";
import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { workspaceAssetResource } from "./filePreviewMode";

/**
 * Download: a file's bytes exactly as saved on the host, under its own name, through a signed
 * attachment URL, so any type downloads the same from a remote browser. Shared by the file
 * context menu and the file viewer header.
 */
export async function downloadFile(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly workspaceRoot: string;
  readonly absolutePath: string;
}): Promise<void> {
  const toast = toastManager.add({ type: "loading", title: "Preparing download…" });
  try {
    const connection = readPreparedConnection(input.environmentId);
    if (!connection) throw new Error("Reconnect to this environment and try again.");
    const resource = {
      ...workspaceAssetResource({ ...input, kind: "media-file" }),
      disposition: "attachment" as const,
    };
    const result = await executeAtomQuery(
      appAtomRegistry,
      assetEnvironment.createUrl({
        environmentId: input.environmentId,
        input: { resource },
      }),
      { label: "file download", reportFailure: false, refresh: true },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("The environment returned an invalid download URL.");
    await downloadMedia(url, input.absolutePath.split(/[\\/]/).at(-1) ?? "file");
    toastManager.update(toast, { type: "success", title: "Download started" });
  } catch (cause) {
    toastManager.update(toast, {
      type: "error",
      title: "Could not download file",
      description: cause instanceof Error ? cause.message : "Please try again.",
    });
  }
}
