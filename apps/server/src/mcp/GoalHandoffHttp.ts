import { CommandId, GoalId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { buildGoalCreateCommand } from "../orchestration/goalTaskCommands.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

interface GoalHandoffRequest {
  readonly title?: unknown;
  readonly brief?: unknown;
  readonly description?: unknown;
}

const HANDOFF_PATH = "/provider-tools/goal/handoff";

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });

const trimString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** Same slugify the UI uses, with a fallback for titles that contain no
 * slug-safe characters (the goal.create slug must be non-empty). */
const slugifyTitle = (title: string): string => {
  const slug = title.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return /[a-z0-9]/.test(slug) ? slug : "goal";
};

/** Resolve the bearer token to a Workstream-capable scope (the same per-session
 * credential the goal/task tools use), or undefined. */
const resolveGoalScope = Effect.fn("GoalHandoffHttp.resolveScope")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const token = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice("Bearer ".length).trim()
    : "";
  const scope = yield* McpSessionRegistry.resolveActiveMcpCredential(token);
  return scope && scope.capabilities.has("workstream") ? scope : undefined;
});

/**
 * Create a NEW goal + a staged (held) root session, both scoped to the caller
 * thread's project. The agent passes only the goal title, the kickoff brief, and
 * an optional description — never a goalId/projectId. The new root thread is
 * created with no worktree so the human's first send routes through the existing
 * composer worktree bootstrap; it is held at `planLane: planned` and carries the
 * brief so the UI can seed the composer for a one-send launch.
 */
const handleGoalHandoff = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveGoalScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): GoalHandoffRequest => ({})),
  )) as GoalHandoffRequest;
  const title = trimString(body.title);
  const brief = trimString(body.brief);
  if (!title) return jsonError(400, "title is required.");
  if (!brief) return jsonError(400, "brief is required.");
  // description may be provided but empty; omit it when blank.
  const description = trimString(body.description);

  const projection = yield* ProjectionSnapshotQuery;
  const caller = yield* projection.getThreadDetailById(scope.threadId);
  if (Option.isNone(caller)) {
    return jsonError(404, "Current provider thread was not found.");
  }
  const callerThread = caller.value;

  // Per-project slug uniqueness mirrors the decider's `requireUniqueGoalSlug`
  // (which clashes against ALL goals in the project, including deleted ones).
  // Auto-suffix `-2`, `-3`, … rather than failing back to the agent.
  const snapshot = yield* projection.getSnapshot();
  const takenSlugs = new Set(
    snapshot.goals
      .filter((goal) => goal.projectId === callerThread.projectId)
      .map((goal) => goal.slug),
  );
  const baseSlug = slugifyTitle(title);
  let slug = baseSlug;
  for (let suffix = 2; takenSlugs.has(slug); suffix += 1) {
    slug = `${baseSlug}-${suffix}`;
  }

  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const goalId = GoalId.make(yield* crypto.randomUUIDv4);
  const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
  const engine = yield* OrchestrationEngineService;

  yield* engine.dispatch(
    buildGoalCreateCommand({
      commandId: CommandId.make(`server:goal-handoff:create-goal:${yield* crypto.randomUUIDv4}`),
      goalId,
      projectId: callerThread.projectId,
      slug,
      title,
      ...(description !== undefined ? { description } : {}),
      createdAt: now,
    }) satisfies OrchestrationCommand,
  );

  // Staged root session: no parent, held at `planned`, NO worktree (so the
  // composer bootstrap provisions a fresh one on the human's first send),
  // model/runtime inherited from the caller, brief stored for composer seeding.
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`server:goal-handoff:create-thread:${yield* crypto.randomUUIDv4}`),
    threadId,
    projectId: callerThread.projectId,
    goalId,
    parentThreadId: null,
    purpose: title,
    brief,
    planLane: "planned",
    title,
    modelSelection: callerThread.modelSelection,
    runtimeMode: callerThread.runtimeMode,
    interactionMode: callerThread.interactionMode,
    branch: null,
    worktreePath: null,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ goalId, threadId, slug });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to hand off the goal."),
    ),
  ),
);

const goalToolUrlFromMcpEndpoint = (mcpEndpoint: string, path: string): string =>
  mcpEndpoint.endsWith("/mcp")
    ? `${mcpEndpoint.slice(0, -"/mcp".length)}${path}`
    : `${mcpEndpoint.replace(/\/$/, "")}${path}`;

export const goalHandoffUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  goalToolUrlFromMcpEndpoint(mcpEndpoint, HANDOFF_PATH);

export const layer = HttpRouter.add("POST", HANDOFF_PATH, handleGoalHandoff);
