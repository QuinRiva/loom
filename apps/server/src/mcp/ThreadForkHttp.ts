import { CommandId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveWorkstreamScope } from "./httpScope.ts";
import { PROVIDER_TOOL_PATHS } from "./toolPaths.ts";

interface ThreadForkRequest {
  readonly threadTitle?: unknown;
}

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });

const trimString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * Fork THIS thread: create a staged (held) root thread that starts with a full
 * copy of the caller's pi conversation context and then diverges
 * independently. Inherits the caller's goal, model, runtime, and worktree; the
 * new thread carries `forkFromThreadId = caller`, so its FIRST provider launch
 * forks the caller's session via native `pi --fork` (fork-once, handled in the
 * driver) — no tokens are spent until the human launches it with one send.
 *
 * Divergence, not delegation: the fork is a ROOT (`parentThreadId: null`),
 * `fanInState` stays `none` (forks never merge back), and it carries no brief
 * (the human's first message is the continuation). The graph renders distinct
 * fork provenance from `forkFromThreadId`, not a spawn/delegation edge.
 *
 * The fork is applied LAZILY at the child's first send (fork-once, in the pi
 * driver), NOT at creation. Creation is therefore NOT idle-gated: this endpoint
 * is called by the source pi thread DURING its own active turn (an agent calls
 * the tool mid-turn), so a creation-time idle check would reject every real
 * call. The load-bearing "never fork a mid-turn jsonl" guard lives at the lazy
 * boundary in `ProviderCommandReactor.ensureSessionForThread`, which refuses the
 * forked child's first launch (readably) if the source is busy at that moment.
 */
const handleThreadFork = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): ThreadForkRequest => ({})),
  )) as ThreadForkRequest;

  const projection = yield* ProjectionSnapshotQuery;
  const source = yield* projection.getThreadDetailById(scope.threadId);
  if (Option.isNone(source)) {
    return jsonError(404, "Current provider thread was not found.");
  }
  const sourceThread = source.value;

  // Fork is pi-only: only PiDriver honours `forkFromThreadId` (`pi --fork`);
  // every other driver would silently start a fresh-context thread. Refuse to
  // fork a non-pi source rather than promise context that would not be copied.
  // (The workstream credential means the caller is a pi agent — which is exactly
  // why creation is NOT idle-gated: the caller is mid-turn when it calls this.)
  if (sourceThread.session?.providerName !== "pi") {
    return jsonError(
      400,
      "Only pi-backed threads can be forked (context copy relies on pi's native session fork). This thread's provider does not support forking.",
    );
  }

  const threadTitle = trimString(body.threadTitle) ?? `${sourceThread.title} (fork)`;

  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
  const engine = yield* OrchestrationEngineService;

  // Staged ROOT thread: held at `planned`, carrying `forkFromThreadId` so the
  // first launch forks the source's pi session. No brief — the human's first
  // send is the divergent continuation (and the fork-once moment).
  //
  // Divergence, not delegation: `parentThreadId: null` makes the fork a ROOT
  // thread rather than a delegated child of the source's parent. That keeps it
  // OUT of every delegation rail — the dispatcher/wake/digest all skip
  // `parentThreadId === null`, and shared-isolation roots are skipped by the
  // fan-in reactor — so a fork never wakes or merges back into the source's
  // orchestrator. The “forked from” lineage is carried by `forkFromThreadId`
  // (badge/edge), not by the parent edge.
  //
  // MVP worktree decision (DELIBERATE deviation from the research report, which
  // recommended an isolated worktree): the fork INHERITS the source's worktree
  // and branch (like goal_continue), rather than provisioning its own `ws/…`
  // branch. The pi session still diverges (a separate jsonl), but two LIVE
  // continuations would share files on disk. This deviation was explicitly
  // ACCEPTED FOR MVP by the orchestrator (isolated-worktree forks are a
  // follow-up); `isolation` is inherited so the field stays honest.
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`server:thread-fork:create-thread:${yield* crypto.randomUUIDv4}`),
    threadId,
    projectId: sourceThread.projectId,
    goalId: sourceThread.goalId,
    parentThreadId: null,
    forkFromThreadId: sourceThread.id,
    purpose: threadTitle,
    planLane: "planned",
    isolation: sourceThread.isolation,
    title: threadTitle,
    modelSelection: sourceThread.modelSelection,
    runtimeMode: sourceThread.runtimeMode,
    interactionMode: sourceThread.interactionMode,
    branch: sourceThread.branch,
    worktreePath: sourceThread.worktreePath,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    threadId,
    forkFromThreadId: sourceThread.id,
    title: threadTitle,
    rendered: `Forked this thread into staged session ${threadId} (${threadTitle}), inheriting its full conversation context. It launches (and forks the session) on the first send — no tokens are spent until then.`,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to fork the thread."),
    ),
  ),
);

export const layer = HttpRouter.add("POST", PROVIDER_TOOL_PATHS.thread_fork, handleThreadFork);
