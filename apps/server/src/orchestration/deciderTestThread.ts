/**
 * The loom-only half of an `OrchestrationThread` read-model row, as a default
 * block decider tests can spread.
 *
 * Every decider test builds a whole thread row by hand, and the fork adds ~27
 * workstream fields to that row. Without one shared block each upstream pull
 * breaks every fixture individually, which is exactly what cadence pull 7 hit.
 * Spread this first, then override only what the test is about.
 */
export const loomThreadFixtureDefaults = {
  goalId: null,
  parentThreadId: null,
  role: null,
  purpose: null,
  brief: null,
  kickoffBriefPath: null,
  graphKey: null,
  planLane: "in_progress",
  attention: [],
  blockedBy: [],
  spawnGeneration: null,
  forkFromThreadId: null,
  continuesThreadId: null,
  reportPath: null,
  routes: [],
  gateRounds: 0,
  pendingRework: false,
  lastOutcome: null,
  isolation: "shared",
  fanInState: "none",
  cumulativeCostUsd: 0,
  toolUses: null,
  usedTokens: null,
  maxTokens: null,
  diffAdditions: null,
  diffDeletions: null,
  handoffDestinations: [],
  notifySendLog: [],
  pullRequests: [],
  proposedPlans: [],
} as const;
