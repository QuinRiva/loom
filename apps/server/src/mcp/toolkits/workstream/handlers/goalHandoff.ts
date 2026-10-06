/**
 * `mcp__t3-code__goal_handoff` (P3-15): a NEW goal and its root session in a fresh worktree
 * of the target project, started on the brief at once (not held). The order is
 * the point: the thread exists and carries the goal BEFORE its first message,
 * so the first session composes with the goal context. Upstream's launch
 * claims an existing empty thread (`reuseExistingThread`) and holds the
 * brief's run in `preparing` until the worktree and setup script are ready, so
 * the brief is the first message and its turn runs in the new worktree:
 *
 *   goals.upsert → thread.create → thread.goal.set →
 *   ThreadLaunchService.launch(worktree, initialMessage = brief) →
 *   thread.handoff.record on the caller.
 *
 * Ported from V1's `GoalHandoffHttp.ts` (which staged the root for a human send).
 *
 * @module mcp/toolkits/workstream/handlers/goalHandoff
 */
import { type CommandId, GoalId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../../../../git/GitWorkflowService.ts";
import { HANDOFF_DRAFTER_ROLE } from "../../../../loom/handoff/handoffDraft.ts";
import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import * as ThreadLaunchService from "../../../../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../../../../project/ProjectService.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import { LoomToolError, type LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { createdUuid, requestKey, stableCommandId, stableThreadId } from "../idempotency.ts";
import { asToolError, dispatch, fail, nowIso, publishGoal, requireShell } from "./shared.ts";

const slugifyTitle = (title: string): string => {
  const slug = title.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return /[a-z0-9]/.test(slug) ? slug : "goal";
};

export const goalHandoff = Effect.fn("LoomToolkit.goalHandoff")(function* (
  input: LoomToolInput<"goal_handoff">,
  caller: WorkstreamCaller,
) {
  const [title, brief, description] = [input.title, input.brief, input.description].map((text) =>
    text.trim(),
  );
  if (!title) return yield* fail("title is required.");
  if (!brief) return yield* fail("brief is required.");
  if (!description) return yield* fail("description is required.");
  const store = yield* LoomStore.LoomStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const self = yield* requireShell(caller.threadId);
  const workstream = yield* asToolError(store.getWorkstream(caller.threadId));
  const role = workstream?.role ?? null;

  // The caller's own project unless `project` names another (id, else title).
  // An inbox role's project is a mailbox, not a workspace, so it must name one.
  const active = (yield* asToolError(projects.snapshot)).projects.filter(
    (project) => project.deletedAt === null,
  );
  const titles = active.map((project) => `'${project.title}'`).join(", ");
  const projectRef = input.project?.trim();
  const matches =
    projectRef === undefined || projectRef.length === 0
      ? role?.endsWith("-inbox")
        ? []
        : active.filter((project) => project.id === self.projectId)
      : active.filter(
          (project) =>
            project.id === projectRef || project.title.toLowerCase() === projectRef.toLowerCase(),
        );
  if (matches.length !== 1)
    return yield* fail(
      projectRef === undefined || projectRef.length === 0
        ? `This thread's project is an inbox — handoffs must name a target project. Pass 'project' as one of: ${titles}.`
        : `Project '${projectRef}' ${matches.length === 0 ? "was not found" : "is ambiguous"}. Active projects: ${titles}.`,
    );
  const project = matches[0]!;

  const key = yield* requestKey(input.clientRequestId);
  const commandId = (step: string) => stableCommandId(caller, key, `goal_handoff:${step}`);
  const threadId = stableThreadId(caller, key, "goal_handoff");
  const goalId = GoalId.make(
    `goal:${yield* createdUuid(caller, input.clientRequestId, "goal_handoff")}`,
  );

  // Slugs stay unique per project (deleted goals included); a clash takes -2, -3, ….
  const goals = yield* asToolError(store.goals.listByProject(project.id, { includeDeleted: true }));
  const existing = goals.find((goal) => goal.id === goalId);
  const taken = new Set(goals.filter((goal) => goal.id !== goalId).map((goal) => goal.slug));
  let slug = existing?.slug ?? slugifyTitle(title);
  for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${slugifyTitle(title)}-${suffix}`;
  yield* asToolError(
    store.goals.upsert({ id: goalId, projectId: project.id, slug, title, description }),
  );
  yield* publishGoal(goalId);

  yield* dispatch({
    type: "thread.create",
    commandId: commandId("create"),
    createdBy: "agent",
    creationSource: "mcp",
    threadId,
    projectId: project.id,
    title,
    modelSelection: self.modelSelection,
    runtimeMode: self.runtimeMode,
    interactionMode: self.interactionMode,
    branch: null,
    worktreePath: null,
  });
  yield* dispatch({
    type: "thread.goal.set",
    commandId: commandId("goal-set"),
    threadId,
    createdAt: yield* nowIso,
    goalId,
  });

  const isDrafter = role === HANDOFF_DRAFTER_ROLE;
  yield* launch({
    commandId: commandId("launch"),
    threadId,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    title,
    self,
    senderThreadId: caller.threadId,
    // The drafter is a fork of the session the human flagged; the receiving
    // agent can drill into it for anything this focused brief omits.
    text: isDrafter
      ? `${brief}\n\n---\nContext snapshot: thread ${caller.threadId} holds a frozen fork of the originating session at handoff time; ${t("consult_thread")} it for anything this brief omits.`
      : brief,
  });

  // A durable trace on the caller (and, for a drafter, on the session it forked
  // from, which outlives the archived drafter).
  const record = (on: ThreadId, step: string) =>
    Effect.flatMap(nowIso, (createdAt) =>
      dispatch({
        type: "thread.handoff.record",
        commandId: commandId(step),
        threadId: on,
        createdAt,
        drafterThreadId: caller.threadId,
        destinationGoalId: goalId,
        destinationThreadId: threadId,
      }),
    );
  yield* record(caller.threadId, "record");
  // The drafter is a Loom spawn with `forkFromThreadId` (3b, DL-384), not a V2 `thread.fork`.
  const source = workstream?.forkFromThreadId ?? null;
  if (isDrafter && source !== null) yield* record(source, "record-source").pipe(Effect.ignore);

  return `Handed off new goal ${goalId} (${title}) in project '${project.title}': its root session ${threadId} is starting on your brief in a fresh worktree.`;
});

/** The brief's launch into a fresh worktree based on the project checkout's current branch. */
const launch = Effect.fn("LoomToolkit.goalHandoffLaunch")(function* (input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly self: Effect.Success<ReturnType<typeof requireShell>>;
  readonly senderThreadId: ThreadId;
  readonly text: string;
}) {
  const baseRef = yield* (yield* GitWorkflowService.GitWorkflowService)
    .localStatus({ cwd: input.workspaceRoot })
    .pipe(
      Effect.map((status) => Option.fromNullishOr(status.refName)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  yield* (yield* ThreadLaunchService.ThreadLaunchService)
    .launch({
      commandId: input.commandId,
      threadId: input.threadId,
      reuseExistingThread: true,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.self.modelSelection,
      runtimeMode: input.self.runtimeMode,
      interactionMode: input.self.interactionMode,
      workspaceStrategy: {
        type: "worktree",
        baseRef: Option.getOrElse(baseRef, () => "HEAD"),
        startFromOrigin: true,
      },
      initialMessage: { text: input.text, attachments: [], senderThreadId: input.senderThreadId },
      createdBy: "agent",
      creationSource: "mcp",
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new LoomToolError({
            message: `${error.message}${error.cause instanceof Error ? ` ${error.cause.message}` : ""} The goal and its thread exist; the brief was not started.`,
          }),
      ),
    );
});
