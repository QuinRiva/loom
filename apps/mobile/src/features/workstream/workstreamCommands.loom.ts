/**
 * loom: the workstream screen's node controls, the three dispatches web's `useWorkstreamCommands`
 * makes: Loom's V2 commands through upstream's `orchestration.dispatchCommand`, and Stop as the
 * thread screen's interrupt. Each returns the command's result so a button can show progress and
 * alert a failure; failures are not reported for it.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type EnvironmentId,
  type LoomOutcome,
  type OrchestrationV2Command,
  type ThreadId,
} from "@t3tools/contracts";

import { uuidv4 } from "../../lib/uuid";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const commandMeta = () => ({
  commandId: CommandId.make(uuidv4()),
  createdAt: new Date().toISOString(),
});

export function useWorkstreamCommands(environmentId: EnvironmentId) {
  const dispatchCommand = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const dispatch = (input: OrchestrationV2Command) => dispatchCommand({ environmentId, input });
  return {
    /** Whether this client may change state here: buttons that would are disabled without it. */
    canOperate: useAtomValue(
      orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId),
    ),
    /** Accept done / cancel (`outcome`), or reopen (`null`). */
    setOutcome: (threadId: ThreadId, outcome: LoomOutcome | null) =>
      dispatch({ type: "thread.outcome.set", ...commandMeta(), threadId, outcome }),
    /** Clear every stored attention reason (an absent `reason`). */
    clearAttention: (threadId: ThreadId) =>
      dispatch({ type: "thread.attention.clear", ...commandMeta(), threadId }),
    stop: (threadId: ThreadId) => interruptTurn({ environmentId, input: { threadId } }),
  };
}
