/**
 * loom: 3d-4 goal-keeping (DT-38). A new thread started while viewing a thread
 * that belongs to a Loom goal joins that goal: `useHandleNewThread` files the
 * new draft under the goal's own draft bucket (`goalDraftBucketKey`) and calls
 * `inheritLoomGoal`, which waits for the draft's thread to exist on the server
 * (its first send creates it) and then dispatches `thread.goal.set` through
 * upstream's `orchestration.dispatchCommand`. A Loom goal is
 * `workstream.goalId` — never the provider-native `goal`.
 *
 * The wait is in memory: a draft reloaded before its first send is not
 * re-adopted (its goal bucket keeps it distinct, but it starts goal-less).
 */
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type EnvironmentId, type GoalId, type ThreadId } from "@t3tools/contracts";

import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";
import { environmentThreadShells } from "../state/threads";

const waiting = new Map<ThreadId, () => void>();

export function inheritLoomGoal(environmentId: EnvironmentId, threadId: ThreadId, goalId: GoalId) {
  waiting.get(threadId)?.();
  const unsubscribe = appAtomRegistry.subscribe(
    environmentThreadShells.environmentThreadsAtom(environmentId),
    (threads) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) return;
      stop();
      if (thread.workstream?.goalId === goalId) return;
      void runAtomCommand(appAtomRegistry, orchestrationEnvironment.v2.dispatchCommand, {
        environmentId,
        input: {
          type: "thread.goal.set",
          commandId: CommandId.make(randomUUID()),
          createdAt: new Date().toISOString(),
          threadId,
          goalId,
        },
      });
    },
  );
  const stop = () => {
    unsubscribe();
    waiting.delete(threadId);
  };
  waiting.set(threadId, stop);
}
