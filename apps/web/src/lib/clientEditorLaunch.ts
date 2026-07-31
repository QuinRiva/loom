import { isClientLaunchEditor, zedRemoteEditorUrl, type EditorId } from "@t3tools/contracts";

/**
 * Client-launched editors open via the browser's URL handler on the operator's
 * machine, so the server (which may be a remote VM) must never spawn them.
 *
 * Returns true when the launch was handled here and the caller should skip the
 * `shell.openInEditor` RPC entirely.
 */
export function tryClientEditorLaunch(
  editor: EditorId,
  targetPath: string,
  remoteEditorSshHost: string | null,
): boolean {
  if (!isClientLaunchEditor(editor)) return false;
  if (!remoteEditorSshHost) return false;

  window.location.href = zedRemoteEditorUrl(remoteEditorSshHost, targetPath);
  return true;
}
