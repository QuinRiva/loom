import {
  ProjectId,
  ThreadId,
  type LoomThreadShellFields,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";

import { v2ThreadShell } from "../orchestrationV2TestFixtures.ts";

const ROOT = ThreadId.make("root");

/** A child's sidecar under `root`: briefed, unstarted, unheld, no outcome. */
export const workstreamFields = (
  id: string,
  overrides: Partial<LoomThreadShellFields> = {},
): LoomThreadShellFields => ({
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("project-v2"),
  goalId: null,
  anchorTaskId: null,
  parentThreadId: ROOT,
  rootThreadId: ROOT,
  role: "coder",
  purpose: null,
  graphKey: null,
  kickoffBriefPath: `/briefs/${id}.md`,
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
  handoffDestinations: [],
  archivedAt: null,
  deletedAt: null,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
  consults: [],
  peerMessages: [],
  toolCalls: 0,
  contextUsage: null,
  ...overrides,
});

/** A V2 thread shell carrying `workstream`, with lineage matching its parent. */
export const workstreamShell = (
  workstream: LoomThreadShellFields,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...v2ThreadShell,
  id: workstream.threadId,
  title: `thread ${workstream.threadId}`,
  lineage: {
    parentThreadId: workstream.parentThreadId,
    relationshipToParent: workstream.parentThreadId === null ? null : "subagent",
    rootThreadId: workstream.rootThreadId,
  },
  workstream,
  ...overrides,
});
