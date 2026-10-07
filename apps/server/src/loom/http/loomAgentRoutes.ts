/**
 * The two REST survivors beside `/mcp` (P3-3), for Loom's pi extension: the
 * session profile (seam 5) and `mcp__t3-code__ask_user_question`'s ask + long-poll wait.
 * The bearer is the thread's MCP credential, resolved through
 * `McpSessionRegistry.resolve` exactly as `/mcp` does; the caller is that
 * credential's thread and must hold the `workstream` capability.
 *
 * @module loom/http/loomAgentRoutes
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import type { WorkstreamCaller } from "../../mcp/toolkits/workstream/authorisation.ts";
import {
  DORMANT_TOOLSETS,
  HUMAN_INPUT,
  UPSTREAM_WITHHELD_TOOLS,
} from "../../mcp/toolkits/workstream/families.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import type { LoomSessionProfile } from "../../provider/Drivers/Pi/loomExtension.ts";
import { loomPaths } from "../loomPaths.ts";
import { readLaunchIdentity } from "../workstream/launchIdentity.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import { loadRoleOverlay } from "../prompt/roleOverlay.ts";
import { ASK_COULD_NOT_PRESENT, openAskUserQuestion } from "../userInput/askUserQuestion.ts";
import { LoomAskWaiters } from "../userInput/askWaiters.ts";

export const LOOM_AGENT_ROUTE_PREFIX = "/loom/agent";
/** One long-poll slice; the extension re-polls until the outcome arrives. */
export const LOOM_ASK_POLL_SLICE_MS = 25_000;

const reply = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });

/** Runs `handle` as the credential's thread, or answers 401 / 403. */
const asCaller = <E, R>(
  handle: (caller: WorkstreamCaller) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization ?? "";
    const scope = yield* (yield* McpSessionRegistry.McpSessionRegistry).resolve(
      authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "",
    );
    if (scope === undefined) return reply(401, "A valid T3 thread credential is required.");
    if (!scope.capabilities.has("workstream"))
      return reply(403, "This credential does not carry the workstream capability.");
    return yield* handle({ scope, threadId: scope.thread.threadId });
  });

/**
 * The thread's profile. `humanEngaged` is seam 14's stamp on any user-role
 * message — never the shell's `latestUserAuthoredMessageAt`, which counts
 * upstream's usage-limit resume. A child nobody has written to does not keep
 * `mcp__t3-code__ask_user_question` resident whatever its role says.
 */
export const sessionProfile = Effect.fn("loom.sessionProfile")(function* (threadId: ThreadId) {
  const { thread, messages } = yield* (yield* OrchestratorV2).getThreadRecords(
    threadId,
    ["messages"],
    { messageRoles: ["user"] },
  );
  const humanEngaged = messages.some((message) => message.loom?.humanAuthored === true);
  // A V2 `fork` (thread_fork) is a root the human drives, not a child.
  const hasParent = thread.lineage.relationshipToParent === "subagent";
  const config = yield* ServerConfig.ServerConfig;
  const promptDebugDir = loomPaths(config).workstreamPromptDebugDir;
  // The prompt-debug part writes with plain fs and swallows every failure, so the directory exists first.
  yield* (yield* FileSystem.FileSystem)
    .makeDirectory(promptDebugDir, { recursive: true })
    .pipe(Effect.ignore);
  // The launched profile; a thread that never launched gets its role's profile as of now.
  const launched = yield* readLaunchIdentity(
    loomPaths(config).workstreamLaunchIdentityDir,
    threadId,
  );
  const activeTools = Option.isSome(launched)
    ? launched.value.tools
    : (loadRoleOverlay({
        role: (yield* (yield* LoomStoreV2).getWorkstream(threadId))?.role ?? null,
        projectRoot: thread.worktreePath ?? process.cwd(),
      })?.tools ?? []);
  return {
    activeTools:
      hasParent && !humanEngaged
        ? activeTools.filter((name) => !HUMAN_INPUT.includes(name as never))
        : activeTools,
    families: DORMANT_TOOLSETS,
    humanEngaged,
    hasParent,
    denyList: UPSTREAM_WITHHELD_TOOLS,
    // V1 captured every pi thread's prompt; there is no setting to gate it.
    promptDebugPath: (yield* Path.Path).join(
      promptDebugDir,
      `${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`,
    ),
  } satisfies LoomSessionProfile;
});

const profileRoute = HttpRouter.route(
  "GET",
  `${LOOM_AGENT_ROUTE_PREFIX}/session-profile`,
  asCaller((caller) =>
    sessionProfile(caller.threadId).pipe(
      Effect.map((profile) => HttpServerResponse.jsonUnsafe(profile)),
      Effect.catch((error) => Effect.succeed(reply(500, error.message))),
    ),
  ),
);

const askRoute = HttpRouter.route(
  "POST",
  `${LOOM_AGENT_ROUTE_PREFIX}/user-input/ask`,
  asCaller((caller) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
        readonly toolCallId?: unknown;
        readonly questions?: unknown;
      };
      const requestId = yield* openAskUserQuestion(caller, body);
      return HttpServerResponse.jsonUnsafe({ requestId });
    }).pipe(
      Effect.catchTags({ LoomAskError: (error) => Effect.succeed(reply(409, error.message)) }),
    ),
  ),
);

const waitRoute = HttpRouter.route(
  "GET",
  `${LOOM_AGENT_ROUTE_PREFIX}/user-input/:requestId/wait`,
  asCaller((caller) =>
    Effect.gen(function* () {
      const requestId = (yield* HttpRouter.params).requestId ?? "";
      const outcome = yield* (yield* LoomAskWaiters).wait(
        requestId,
        caller.threadId,
        LOOM_ASK_POLL_SLICE_MS,
      );
      return HttpServerResponse.jsonUnsafe(
        outcome === undefined
          ? { pending: false, rendered: ASK_COULD_NOT_PRESENT }
          : Option.match(outcome, {
              onNone: () => ({ pending: true }),
              onSome: (rendered) => ({ pending: false, rendered }),
            }),
      );
    }),
  ),
);

export const LoomAgentRoutesLive = HttpRouter.addAll([profileRoute, askRoute, waitRoute]);
