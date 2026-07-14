import { CommandId, GoalId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { buildGoalCreateCommand } from "../orchestration/goalTaskCommands.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveWorkstreamScope } from "./httpScope.ts";
import { PROVIDER_TOOL_PATHS } from "./toolPaths.ts";

interface GoalHandoffRequest {
  readonly title?: unknown;
  readonly brief?: unknown;
  readonly description?: unknown;
  readonly threadTitle?: unknown;
  readonly project?: unknown;
}

interface GoalContinueRequest {
  readonly brief?: unknown;
  readonly threadTitle?: unknown;
}

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

/**
 * Inbox/concierge threads (e.g. the Slack bridge's `slack-inbox` role) live in
 * a project that is a mailbox, not a workspace — a handoff defaulting there
 * would provision a worktree of the wrong repo. Such roles must name the
 * target project explicitly.
 */
const isInboxRole = (role: string | null): boolean => role !== null && role.endsWith("-inbox");

/**
 * Create a NEW goal + a staged (held) root session. Both default to the caller
 * thread's project; an optional `project` (id or title) targets another — and
 * inbox-role callers MUST name one, because their own project is a mailbox.
 * The new root thread is created with no worktree so the human's first send
 * routes through the existing composer worktree bootstrap (provisioning from
 * the TARGET project's workspace); it is held at `planLane: planned` and
 * carries the brief so the UI can seed the composer for a one-send launch.
 */
const handleGoalHandoff = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
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
  // The staged root session launches from a brief, not a first user message, so
  // it never auto-titles itself. Honour an explicit sidebar name from the
  // authoring agent; fall back to the goal title when omitted.
  const threadTitle = trimString(body.threadTitle) ?? title;

  const projectRef = trimString(body.project);

  const projection = yield* ProjectionSnapshotQuery;
  const caller = yield* projection.getThreadDetailById(scope.threadId);
  if (Option.isNone(caller)) {
    return jsonError(404, "Current provider thread was not found.");
  }
  const callerThread = caller.value;

  const snapshot = yield* projection.getSnapshot();
  const activeProjects = snapshot.projects.filter((project) => project.deletedAt === null);

  // Resolve the target project: default to the caller's own, unless `project`
  // names another (exact id, else case-insensitive title). Inbox roles get no
  // default — their project is a mailbox, not a workspace.
  let targetProject = activeProjects.find((project) => project.id === callerThread.projectId);
  if (projectRef !== undefined) {
    const matches = activeProjects.filter(
      (project) =>
        project.id === projectRef || project.title.toLowerCase() === projectRef.toLowerCase(),
    );
    if (matches.length !== 1) {
      const titles = activeProjects.map((project) => `'${project.title}'`).join(", ");
      return jsonError(
        400,
        `Project '${projectRef}' ${matches.length === 0 ? "was not found" : "is ambiguous"}. Active projects: ${titles}.`,
      );
    }
    targetProject = matches[0];
  } else if (isInboxRole(callerThread.role)) {
    const titles = activeProjects.map((project) => `'${project.title}'`).join(", ");
    return jsonError(
      400,
      `This thread's project is an inbox — handoffs must name a target project. Pass 'project' as one of: ${titles}.`,
    );
  }
  if (!targetProject) {
    return jsonError(404, "Current thread's project was not found.");
  }

  // Per-project slug uniqueness mirrors the decider's `requireUniqueGoalSlug`
  // (which clashes against ALL goals in the project, including deleted ones).
  // Auto-suffix `-2`, `-3`, … rather than failing back to the agent.
  const takenSlugs = new Set(
    snapshot.goals.filter((goal) => goal.projectId === targetProject.id).map((goal) => goal.slug),
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
      projectId: targetProject.id,
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
    projectId: targetProject.id,
    goalId,
    parentThreadId: null,
    purpose: title,
    brief,
    planLane: "planned",
    title: threadTitle,
    titleProvenance: "curated", // loom: §4 handoff threadTitle is curated
    modelSelection: callerThread.modelSelection,
    runtimeMode: callerThread.runtimeMode,
    interactionMode: callerThread.interactionMode,
    branch: null,
    worktreePath: null,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    goalId,
    threadId,
    slug,
    rendered: `Handed off new goal ${goalId} with staged session ${threadId} (${threadTitle}) in project '${targetProject.title}'. The human launches it with one send.`,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to hand off the goal."),
    ),
  ),
);

/**
 * Continue THIS goal in a fresh-context session: create a staged (held)
 * parent-less sibling thread on the caller's own goal, inheriting its worktree,
 * branch, model and runtime — no new goal, no new worktree. The brief is stored
 * for the composer's one-send launch (same StagedKickoffCard path as
 * goal_handoff), with a predecessor pointer appended so the successor can
 * consult_thread the spent session for anything the brief omits. The shared
 * task tree carries over automatically because it is goal-scoped.
 */
const handleGoalContinue = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): GoalContinueRequest => ({})),
  )) as GoalContinueRequest;
  const brief = trimString(body.brief);
  if (!brief) return jsonError(400, "brief is required.");

  const projection = yield* ProjectionSnapshotQuery;
  const caller = yield* projection.getThreadDetailById(scope.threadId);
  if (Option.isNone(caller)) {
    return jsonError(404, "Current provider thread was not found.");
  }
  const callerThread = caller.value;
  const goalId = callerThread.goalId;
  if (goalId === null) {
    return jsonError(400, "This thread has no active goal to continue (use goal_handoff instead).");
  }
  const snapshot = yield* projection.getSnapshot();
  const goal = snapshot.goals.find((g) => g.id === goalId && g.deletedAt === null);
  if (!goal) return jsonError(404, "This thread's active goal was not found.");

  const threadTitle = trimString(body.threadTitle) ?? `${goal.title} (continued)`;
  // Keep the successor able to drill into the spent context without the brief
  // having to carry the whole history.
  const briefWithPredecessor =
    brief +
    `\n\n---\nPredecessor: this brief hands off from thread ${callerThread.id}` +
    ` ("${callerThread.title}") on the same goal; consult_thread it for any detail not carried above.`;

  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
  const engine = yield* OrchestrationEngineService;

  // Staged parent-less sibling: held at `planned`, SAME goal + worktree +
  // branch as the caller (so the human's launch send skips worktree bootstrap
  // and lands in the caller's tree), model/runtime inherited.
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`server:goal-continue:create-thread:${yield* crypto.randomUUIDv4}`),
    threadId,
    projectId: callerThread.projectId,
    goalId,
    parentThreadId: null,
    purpose: threadTitle,
    brief: briefWithPredecessor,
    planLane: "planned",
    title: threadTitle,
    titleProvenance: "curated", // loom: §4 continuation threadTitle is curated
    modelSelection: callerThread.modelSelection,
    runtimeMode: callerThread.runtimeMode,
    interactionMode: callerThread.interactionMode,
    branch: callerThread.branch,
    worktreePath: callerThread.worktreePath,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    goalId,
    threadId,
    rendered: `Staged continuation session ${threadId} (${threadTitle}) on this goal, sharing this thread's worktree. The human launches it with one send.`,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to stage the continuation."),
    ),
  ),
);

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", PROVIDER_TOOL_PATHS.goal_handoff, handleGoalHandoff),
  HttpRouter.add("POST", PROVIDER_TOOL_PATHS.goal_continue, handleGoalContinue),
);
