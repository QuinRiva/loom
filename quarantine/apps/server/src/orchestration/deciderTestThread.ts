import { loomThreadDefaults, loomThreadShellDefaults } from "@t3tools/contracts";

/**
 * The loom-only half of an `OrchestrationThread` read-model row, as a default
 * block decider tests can spread.
 *
 * Every decider test builds a whole thread row by hand, and the fork adds ~27
 * workstream fields to that row. Without one shared block each upstream pull
 * breaks every fixture individually, which is exactly what cadence pull 7 hit.
 * Spread this first, then override only what the test is about. The field
 * values themselves live in `@t3tools/contracts` beside the schema that adds
 * them, so client-side thread literals share one source with these fixtures;
 * the two collection fields below are upstream's, defaulted here for the same
 * reason.
 */
export const loomThreadFixtureDefaults = {
  ...loomThreadDefaults,
  pullRequests: [],
  proposedPlans: [],
} as const;

/**
 * The same block for an `OrchestrationThreadShell` fixture: the fork thread
 * fields plus the shell-only projections (`LoomThreadShellFields`).
 */
export const loomThreadShellFixtureDefaults = {
  ...loomThreadShellDefaults,
  // Optional on the wire, but explicit here: shell fixtures assert on it.
  finalCommitSha: null,
} as const;
