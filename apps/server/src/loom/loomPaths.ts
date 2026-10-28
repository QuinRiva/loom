// @effect-diagnostics nodeBuiltinImport:off - a pure path derivation, no service needed.
/**
 * Loom's durable directories under the server's state dir, derived here so upstream's `config.ts`
 * stays untouched. The names are V1's exactly, so the importer finds existing reports, briefs and
 * launch identities where V1 left them.
 */
import * as NodePath from "node:path";

import type { ServerDerivedPaths } from "../config.ts";

export const loomPaths = (config: Pick<ServerDerivedPaths, "stateDir">) => ({
  workstreamReportsDir: NodePath.join(config.stateDir, "workstream-reports"),
  workstreamBriefsDir: NodePath.join(config.stateDir, "workstream-briefs"),
  workstreamLaunchIdentityDir: NodePath.join(config.stateDir, "workstream-launch-identity"),
  workstreamPromptDebugDir: NodePath.join(config.stateDir, "prompt-debug"),
  workstreamConsultsDir: NodePath.join(config.stateDir, "workstream-consults"),
  // deployctl writes it (plans/deploy-toasts/plan.mdx §1 in loom-slack-bridge).
  deployNoticePath: NodePath.join(config.stateDir, "deploy-notice.json"),
});

export type LoomPaths = ReturnType<typeof loomPaths>;

/**
 * A thread's captured system prompt (the pi prompt-debug part writes them): `latest`
 * is rewritten at every agent start, `first` is the kickoff, written once. The
 * session profile hands `latest` to pi; `loom.promptCapture` hands both to clients.
 */
export const promptCapturePathsOf = (
  config: Pick<ServerDerivedPaths, "stateDir">,
  threadId: string,
) => {
  const stem = NodePath.join(
    loomPaths(config).workstreamPromptDebugDir,
    threadId.replace(/[^A-Za-z0-9._-]/g, "_"),
  );
  return { latest: `${stem}.md`, first: `${stem}.first.md` };
};
