/**
 * Loom preview fixture data (Phase 3 track 3d-1): V2 shell and message shapes
 * for the workstream board (`WorkstreamPanel`, one thread per derived column),
 * the goal panel (`GoalTasksPanel`, a nested tree with an anchored thread) and
 * the control cards (`ControlDigestCard`, every seam-6 kind — the same payloads
 * the dev seed writes). 3d-2/3d-3 register fixtures in `fixtures.tsx` that
 * render their components against this data; nothing here renders.
 *
 * @module preview/loomFixtures
 */
import {
  EnvironmentId,
  GoalTaskId,
  type LoomGoalShell,
  type LoomGoalTask,
  type LoomThreadShellFields,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { LOOM_SEED, loomSeedControlMessages } from "@t3tools/shared/loomSeedFixture.loom";
import * as DateTime from "effect/DateTime";

const T = LOOM_SEED.threads;
const AT = "2026-10-05T09:00:00.000Z";
const NOW = DateTime.makeUnsafe(AT);
const REPORTS = "/home/dev/.t3/userdata/workstream-reports";
const BRIEFS = "/home/dev/.t3/userdata/workstream-briefs";
const instanceId = ProviderInstanceId.make("pi");

export const loomPreviewEnvironmentId = EnvironmentId.make("preview-environment");

// ---- goal with a nested task tree -----------------------------------------------

const task = (
  n: number,
  text: string,
  done: boolean,
  parent: number | null,
  position: number,
  children: ReadonlyArray<LoomGoalTask> = [],
): LoomGoalTask => ({
  id: GoalTaskId.make(`00000000-0000-4000-8000-00000000000${n}`),
  goalId: LOOM_SEED.goalId,
  parentTaskId:
    parent === null ? null : GoalTaskId.make(`00000000-0000-4000-8000-00000000000${parent}`),
  text,
  done,
  position,
  createdAt: AT,
  updatedAt: AT,
  deletedAt: null,
  children,
});

/** The task a thread is anchored to (`loomPreviewAnchoredThreadId`). */
export const loomPreviewAnchorTaskId = GoalTaskId.make("00000000-0000-4000-8000-000000000004");

export const loomPreviewGoal: LoomGoalShell = {
  id: LOOM_SEED.goalId,
  projectId: LOOM_SEED.projectId,
  slug: "workstream-fixture",
  title: "Render the workstream fixture",
  description:
    "A realistic Loom workstream: an orchestrator, a gated pair mid-round, a quiescent child, a blocked dependent and a cancelled subtree.",
  tasks: [
    task(0, "Seed a realistic workstream fixture", true, null, 0, [
      task(1, "Write the threads through real commands", true, 0, 1),
    ]),
    task(2, "Verify the seeded surfaces", false, null, 2, [
      task(3, "Render every board column", false, 2, 3, [
        task(4, "Confirm the task-to-thread chip on anchored rows", false, 3, 4),
      ]),
      task(5, "Render every control card", false, 2, 5),
    ]),
  ],
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
};

// ---- thread shells: one per derived board column, plus the attention cases ------

const workstream = (
  threadId: ThreadId,
  fields: Partial<LoomThreadShellFields> = {},
): LoomThreadShellFields => ({
  threadId,
  projectId: LOOM_SEED.projectId,
  goalId: LOOM_SEED.goalId,
  anchorTaskId: null,
  parentThreadId: T.root,
  rootThreadId: T.root,
  role: "coder",
  purpose: null,
  graphKey: null,
  kickoffBriefPath: `${BRIEFS}/${threadId}.md`,
  held: false,
  heldSince: null,
  outcome: null,
  outcomeAt: null,
  kickoffAt: null,
  attention: [],
  blockedBy: [],
  dependenciesSince: null,
  spawnGeneration: null,
  forkFromThreadId: null,
  continuesThreadId: null,
  routes: [],
  gateRounds: 0,
  pendingRework: false,
  lastOutcome: null,
  reportPath: null,
  archivedAt: null,
  deletedAt: null,
  createdAt: AT,
  updatedAt: AT,
  consults: [],
  peerMessages: [],
  ...fields,
});

const shell = (
  title: string,
  ws: LoomThreadShellFields,
  fields: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: ws.threadId,
  projectId: LOOM_SEED.projectId,
  title,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "cliproxy/claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/home/dev/.t3/worktrees/seed-workspace",
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: ws.parentThreadId,
    relationshipToParent: ws.parentThreadId === null ? null : "subagent",
    rootThreadId: ws.rootThreadId,
  },
  forkedFrom: null,
  createdBy: ws.parentThreadId === null ? "user" : "agent",
  creationSource: ws.parentThreadId === null ? "web" : "mcp",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  workstream: ws,
  ...fields,
});

const started = { kickoffAt: AT };
const outcomeRecord = (
  outcome: string,
  decision: "terminal" | "loop" | "yield",
  synthesised = false,
) => ({
  outcome,
  decision,
  round: decision === "loop" ? 1 : 0,
  ...(synthesised ? { synthesised: true } : {}),
  eventId: null,
  at: AT,
});

/** The thread `loomPreviewAnchorTaskId` is anchored to (the goal panel's chip). */
export const loomPreviewAnchoredThreadId = T.coderDone;

/**
 * Keyed by the column `deriveBoardColumn` puts each in (plus the root and the
 * attention cases), so a fixture can pick one per column.
 */
export const loomPreviewThreads = {
  root: shell(
    "Deliver the workstream fixture",
    workstream(T.root, { parentThreadId: null, role: null, kickoffBriefPath: null, ...started }),
    { activityRunStatus: "running", status: "running" },
  ),
  held: shell(
    "Fixture follow-through (staged)",
    workstream(T.stagedRoot, {
      parentThreadId: null,
      rootThreadId: T.stagedRoot,
      role: "orchestrator",
      held: true,
      heldSince: AT,
      continuesThreadId: T.root,
    }),
  ),
  blocked: shell("Document checkpoint refs", workstream(T.blocked, { blockedBy: [T.quiescent] })),
  ready: shell("Write the parser docs", workstream("seed-thread-ready" as ThreadId)),
  /** Blocked with derived `brief-needed`: spawned without a brief. */
  briefNeeded: shell(
    "Wire the loader into the CLI",
    workstream(T.unbriefed, { kickoffBriefPath: null }),
  ),
  inProgress: shell(
    "Parser with review gate",
    workstream(T.gateCoder, {
      ...started,
      pendingRework: true,
      lastOutcome: outcomeRecord("done", "terminal"),
      reportPath: `${REPORTS}/${T.gateCoder}.md`,
    }),
    { activityRunStatus: "running", status: "running" },
  ),
  done: shell(
    "Add config loader",
    workstream(T.coderDone, {
      ...started,
      anchorTaskId: loomPreviewAnchorTaskId,
      outcome: "done",
      outcomeAt: AT,
      lastOutcome: outcomeRecord("done", "terminal"),
      reportPath: `${REPORTS}/${T.coderDone}.md`,
    }),
  ),
  cancelled: shell(
    "Abandoned experiment",
    workstream(T.cancelledLead, { ...started, role: "lead", outcome: "cancelled", outcomeAt: AT }),
  ),
  cancelledGrandchild: shell(
    "Benchmark the alternative parser",
    workstream(T.cancelledGrandchild, {
      ...started,
      parentThreadId: T.cancelledLead,
      outcome: "cancelled",
      outcomeAt: AT,
    }),
  ),
  /** In progress, waiting in the gate (looped findings to the coder). */
  reviewerInGate: shell(
    "Review the parser",
    workstream(T.gateReviewer, {
      ...started,
      role: "reviewer",
      blockedBy: [T.gateCoder],
      routes: [
        { on: ["needs_rework"], kind: "loop", to: T.gateCoder, maxRounds: 2 },
        { on: ["clean"], kind: "resolve" },
      ],
      gateRounds: 1,
      lastOutcome: {
        ...outcomeRecord("needs_rework", "loop"),
        counts: { mustFix: 2, niceToHave: 1 },
      },
      reportPath: `${REPORTS}/${T.gateReviewer}.md`,
    }),
  ),
  /** Yielded: attention `awaiting_orchestrator`, synthesised report (not a column). */
  quiescent: shell(
    "Survey checkpoint refs",
    workstream(T.quiescent, {
      ...started,
      role: "researcher",
      attention: ["awaiting_orchestrator"],
      lastOutcome: outcomeRecord("quiescent", "yield", true),
      reportPath: `${REPORTS}/${T.quiescent}.quiescent-run-1.md`,
    }),
  ),
  /** A root with stored `needs_guidance`. */
  needsGuidance: shell(
    "Plan the migration (needs guidance)",
    workstream(T.needsGuidanceRoot, {
      parentThreadId: null,
      rootThreadId: T.needsGuidanceRoot,
      role: null,
      kickoffBriefPath: null,
      ...started,
      attention: ["needs_guidance"],
    }),
  ),
  /** Derived `awaiting_approval` from a pending command approval. */
  awaitingApproval: shell(
    "Run the migration",
    workstream("seed-thread-awaiting-approval" as ThreadId, started),
    {
      activityRunStatus: "waiting",
      status: "waiting",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-approval"),
        kind: "command",
        createdAt: NOW,
      },
    },
  ),
  /** Derived `awaiting_input` from a pending question. */
  awaitingInput: shell(
    "Choose the parser",
    workstream("seed-thread-awaiting-input" as ThreadId, started),
    {
      activityRunStatus: "waiting",
      status: "waiting",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("loom-ask:preview"),
        kind: "user_input",
        createdAt: NOW,
      },
    },
  ),
} satisfies Record<string, OrchestrationV2ThreadShell>;

export const loomPreviewShellSnapshot: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [
    {
      id: LOOM_SEED.projectId,
      title: "Seed Fixture Project",
      workspaceRoot: "/home/dev/.t3/worktrees/seed-workspace",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: AT,
      updatedAt: AT,
    },
  ],
  threads: Object.values(loomPreviewThreads),
  archivedThreads: [],
  goals: [loomPreviewGoal],
};

// ---- control messages on the root (seam 6) ------------------------------------

export const loomPreviewControlMessages: ReadonlyArray<OrchestrationV2ConversationMessage> =
  loomSeedControlMessages({
    coderDone: `${REPORTS}/${T.coderDone}.md`,
    gateReviewer: `${REPORTS}/${T.gateReviewer}.md`,
    quiescent: `${REPORTS}/${T.quiescent}.quiescent-run-1.md`,
  }).map((control) => ({
    createdBy: "agent",
    creationSource: "server",
    id: MessageId.make(`message:preview-control:${control.key}`),
    threadId: T.root,
    runId: null,
    nodeId: null,
    role: "user",
    text: control.text,
    attachments: [],
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
    loom: {
      origin: control.payload.notice === "notify" ? "notify" : "control_notice",
      humanAuthored: false,
      controlPayload: control.payload,
    },
  }));
