/**
 * `mcp__t3-code__consult_thread`: a GLOBAL read-only question to any thread the server
 * knows, by exact id or fuzzy name (an ambiguous name returns ranked
 * candidates and runs nothing). The session the throwaway fork reads is the
 * target's provider thread's strong `nativeThreadRef` — never a name or path
 * guess; a thread without one is refused. The resolved consult is recorded on
 * the asker (`thread.consult.record`) for the board's consult edges.
 *
 * @module mcp/toolkits/workstream/handlers/consult
 */
import { CommandId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { LoomThreadConsult } from "../../../../loom/workstream/consult.ts";
import { resolveThread } from "../../../../loom/workstream/threadResolve.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { requestKey } from "../idempotency.ts";
import { renderConsultCandidates } from "../render.ts";
import { asToolError, candidateOf, dispatch, fail, senderDescriptor } from "./shared.ts";

const QUESTION_MAX_CHARS = 8_000;

/** The pi session file a fork of `shell` reads: its active (else latest pi) provider thread's strong ref. */
const consultSessionFile = Effect.fn("LoomToolkit.consultSessionFile")(function* (
  shell: OrchestrationV2ThreadShell,
) {
  const { providerThreads } = yield* asToolError(
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.getThreadRecords(shell.id, ["providerThreads"]),
    ),
  );
  const ref = (
    providerThreads.find((thread) => thread.id === shell.activeProviderThreadId) ??
    providerThreads.findLast((thread) => thread.driver === "pi")
  )?.nativeThreadRef;
  if (ref?.driver !== "pi" || ref.strength !== "strong" || ref.nativeId == null)
    return yield* fail(
      `Thread ${shell.id} («${shell.title}») has no inspectable pi session: ${
        ref == null
          ? "it has never run a pi turn"
          : `its provider thread exposes a ${ref.strength} ${ref.driver} session ref, not a strong pi session file`
      }. Nothing was consulted.`,
    );
  return ref.nativeId;
});

export const consultThread = Effect.fn("LoomToolkit.consultThread")(function* (
  input: LoomToolInput<"consult_thread">,
  caller: WorkstreamCaller,
) {
  const question = input.question.trim();
  if (question.length === 0) return yield* fail("question is required.");
  if (question.length > QUESTION_MAX_CHARS)
    return yield* fail(`question must be at most ${QUESTION_MAX_CHARS} characters.`);
  const resolved = yield* asToolError(resolveThread(input));
  if (resolved.kind === "missing") return yield* fail(resolved.message);
  if (resolved.kind === "candidates")
    return renderConsultCandidates(resolved.shells.map(candidateOf));
  const target = resolved.shell;
  const sessionFile = yield* consultSessionFile(target);

  const startedAt = yield* DateTime.now;
  const { answer, forkSessionPath } = yield* asToolError(
    Effect.flatMap(LoomThreadConsult, (consult) =>
      Effect.flatMap(senderDescriptor(caller, target), (asker) =>
        consult.ask({ sessionFile, question, asker }),
      ),
    ),
  );
  const finishedAt = yield* DateTime.now;
  // Best-effort: a failed record never costs the asker its answer.
  yield* dispatch({
    type: "thread.consult.record",
    commandId: CommandId.make(`server:consult-thread:${yield* requestKey(undefined)}`),
    threadId: caller.threadId,
    createdAt: DateTime.formatIso(finishedAt),
    targetThreadId: target.id,
    targetTitle: target.title || target.id,
    question,
    answer,
    resolved: true,
    durationMs: Math.max(0, DateTime.toEpochMillis(finishedAt) - DateTime.toEpochMillis(startedAt)),
    ...(forkSessionPath === undefined ? {} : { forkSessionPath }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("loom.consult.record-failed", { targetThreadId: target.id, cause }),
    ),
  );
  return answer;
});
