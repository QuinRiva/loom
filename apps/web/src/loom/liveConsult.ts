/**
 * loom: the live consult a consult card shows, from the client-runtime store
 * the shell stream's `consult.updated` items feed. The card knows its asker
 * thread and question; the consult it shows is the one with that question
 * that started with its item (a same-question consult asked later is not it).
 */
import {
  getLiveConsults,
  liveConsultKey,
  subscribeLiveConsults,
} from "@t3tools/client-runtime/state/loom/consults";
import {
  consultQuestionKey,
  type EnvironmentId,
  type LoomLiveConsult,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useSyncExternalStore } from "react";

const NONE: ReadonlyArray<LoomLiveConsult> = Object.freeze([]);
/** The MCP request reaches the server a moment after pi opens the tool item. */
const START_SKEW_MS = 10_000;

export function useLiveConsult(input: {
  readonly environmentId: EnvironmentId;
  readonly askerThreadId: ThreadId;
  readonly question: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}): LoomLiveConsult | null {
  const key =
    input.question === null
      ? null
      : liveConsultKey(
          input.environmentId,
          input.askerThreadId,
          consultQuestionKey(input.question),
        );
  const subscribe = useCallback(
    (listener: () => void) => (key === null ? () => {} : subscribeLiveConsults(key, listener)),
    [key],
  );
  const consults = useSyncExternalStore(subscribe, () =>
    key === null ? NONE : getLiveConsults(key),
  );
  const from = input.startedAt === null ? -Infinity : Date.parse(input.startedAt) - START_SKEW_MS;
  const to = input.completedAt === null ? Infinity : Date.parse(input.completedAt);
  return (
    consults.findLast((consult) => {
      const started = Date.parse(consult.startedAt);
      return started >= from && started <= to;
    }) ?? null
  );
}
