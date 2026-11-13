// loom: the Deploy row (plans/loom-deploy-redesign §4.3), mounted by one marked line in
// `SettingsPanels.tsx`; the command palette's "Deploy Loom" opens the same confirmation.
import { useAtomValue } from "@effect/atom-react";
import {
  deployWords,
  type LoomDeployState,
  roughDuration,
} from "@t3tools/client-runtime/state/loom/deploy";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { searchableSetting } from "../components/settings/settingsSearch";
import { SettingsRow } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { loomCommands } from "./loomGoalState";

const deployState = (environmentId: EnvironmentId) =>
  loomCommands.deploy({ environmentId, input: {} });
const valueOf = (result: AsyncResult.AsyncResult<LoomDeployState, unknown>) =>
  Option.getOrNull(AsyncResult.value(result));

export const useLoomDeploy = (environmentId: EnvironmentId) =>
  valueOf(useAtomValue(deployState(environmentId)));

/** "2:32 pm" today, "11 Nov, 11:55 am" another day. */
export function deployClock(iso: string): string {
  const at = new Date(iso);
  const today = at.toDateString() === new Date().toDateString();
  return at.toLocaleString(undefined, {
    ...(today ? {} : { day: "numeric", month: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The servers this client may deploy: where the palette offers "Deploy Loom". */
export const deployableEnvironmentIdsAtom = Atom.make((get) =>
  get(environmentSummaries.environmentIdsAtom).filter(
    (environmentId) =>
      valueOf(get(deployState(environmentId)))?.available != null &&
      get(loomCommands.startDeploy.permissionAtom(environmentId)),
  ),
).pipe(Atom.withLabel("loom-deploy:deployable"));

const failed = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
};

/** Asks first; the start warning that follows comes to every client from the server. */
export async function confirmDeploy(environmentId: EnvironmentId): Promise<void> {
  const available = valueOf(appAtomRegistry.get(deployState(environmentId)))?.available;
  const confirmed = await ensureLocalApi().dialogs.confirm(
    [
      "Deploy Loom?",
      `This builds main and restarts Loom in ${available == null ? "a few minutes" : roughDuration(available.stopAfterSeconds)}. Everyone using Loom is warned now, and running agent turns are interrupted and resume when it is back.`,
    ].join("\n"),
  );
  if (!confirmed) return;
  const result = await runAtomCommand(appAtomRegistry, loomCommands.startDeploy, {
    environmentId,
    input: {},
  });
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    failed("Could not start the deploy", result);
  }
}

function LoomDeployRow({ environmentId }: { environmentId: EnvironmentId }) {
  const state = useLoomDeploy(environmentId);
  const canDeploy = useAtomValue(loomCommands.startDeploy.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  if (state === null) return null;
  const { row, bridgeFault } = deployWords(state, deployClock);
  if (row === null) return null;

  const act = async () => {
    setBusy(true);
    if (row.action === "deploy") await confirmDeploy(environmentId);
    else {
      const result = await runAtomCommand(appAtomRegistry, loomCommands.cancelDeploy, {
        environmentId,
        input: {},
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        failed("Could not cancel the deploy", result);
      }
    }
    setBusy(false);
  };

  return (
    <SettingsRow
      {...searchableSetting("loom-deploy")}
      description={
        <span className="block">
          {row.text}
          {bridgeFault === null ? null : <span className="mt-1 block">{bridgeFault}</span>}
        </span>
      }
      control={
        row.action === null ? null : (
          <Button
            size="sm"
            variant={row.action === "deploy" ? "default" : "outline"}
            disabled={busy || !canDeploy}
            onClick={() => void act()}
          >
            {row.action === "deploy" ? "Deploy" : "Cancel"}
          </Button>
        )
      }
    />
  );
}

/** One row per selected server that can deploy itself; none anywhere else. */
export function LoomDeployRows({
  environmentIds,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}) {
  return environmentIds.map((environmentId) => (
    <LoomDeployRow key={environmentId} environmentId={environmentId} />
  ));
}
