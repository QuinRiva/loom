import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExecutionEnvironmentDescriptor, ServerSelfUpdateMethod } from "./environment.ts";
import { ServerAuthDescriptor } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KeybindingCommand,
  KeybindingValue,
  KeybindingWhen,
  ResolvedKeybindingsConfig,
} from "./keybindings.ts";
import { EditorId } from "./editor.ts";
import { ModelCapabilities } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { AccountUsageSnapshot, AccountUsageWindowKind } from "./providerRuntime.ts";
import { ServerSettings } from "./settings.ts";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  isCustom: Schema.Boolean,
  isDefault: Schema.optional(Schema.Boolean),
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerProviderSlashCommandInput = Schema.Struct({
  hint: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;

export const ServerProviderSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderSkill = typeof ServerProviderSkill.Type;

/**
 * Availability of a configured provider instance from the runtime's POV.
 *
 *  - `available` — the build ships this driver and an instance is wired
 *    up. Default for legacy snapshots produced from the closed
 *    `ServerSettings.providers` map.
 *  - `unavailable` — the user's `ServerSettings.providerInstances` (or a
 *    persisted thread / session binding) references a driver this build
 *    doesn't ship. Common after rolling back from a fork or PR branch
 *    that introduced a new driver. The snapshot is preserved so the UI
 *    can render "missing driver" affordances and so the data round-trips
 *    when the user moves back to the fork.
 *
 * Snapshots with `availability: "unavailable"` MUST set
 * `installed: false` and `enabled: false`; the runtime refuses turn
 * starts against them with a structured error.
 */
export const ServerProviderAvailability = Schema.Literals(["available", "unavailable"]);
export type ServerProviderAvailability = typeof ServerProviderAvailability.Type;

export const ServerProviderContinuation = Schema.Struct({
  groupKey: TrimmedNonEmptyString,
});
export type ServerProviderContinuation = typeof ServerProviderContinuation.Type;

export const ServerProviderVersionAdvisoryStatus = Schema.Literals([
  "unknown",
  "current",
  "behind_latest",
]);
export type ServerProviderVersionAdvisoryStatus = typeof ServerProviderVersionAdvisoryStatus.Type;

export const ServerProviderVersionAdvisory = Schema.Struct({
  status: ServerProviderVersionAdvisoryStatus,
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  updateCommand: Schema.NullOr(TrimmedNonEmptyString),
  canUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderVersionAdvisory = typeof ServerProviderVersionAdvisory.Type;

export const ServerProviderUpdateStatus = Schema.Literals([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unchanged",
]);
export type ServerProviderUpdateStatus = typeof ServerProviderUpdateStatus.Type;

export const ServerProviderUpdateState = Schema.Struct({
  status: ServerProviderUpdateStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
});
export type ServerProviderUpdateState = typeof ServerProviderUpdateState.Type;

export const ServerProvider = Schema.Struct({
  // Routing key for the configured instance this snapshot represents. This
  // is the only stable identity consumers may use for provider routing.
  instanceId: ProviderInstanceId,
  // Open driver kind slug that selects the implementation handling this
  // instance. It is metadata/capability context, not a routing key.
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  continuation: Schema.optional(ServerProviderContinuation),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  requiresNewThreadForModelChange: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  // Optional for back-compat: every legacy producer omits this field and
  // an absent value is interpreted as `"available"` by consumers (see
  // `isProviderAvailable`). New `ProviderInstanceRegistry` outputs set it
  // explicitly so the UI can render unavailable shadows from
  // `ServerSettings.providerInstances`.
  availability: Schema.optional(ServerProviderAvailability),
  // Human-readable reason populated when `availability === "unavailable"`.
  // Surfaces in the UI alongside the missing-driver affordance.
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  skills: Schema.Array(ServerProviderSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  versionAdvisory: Schema.optionalKey(ServerProviderVersionAdvisory),
  updateState: Schema.optionalKey(ServerProviderUpdateState),
});
export type ServerProvider = typeof ServerProvider.Type;

export const ServerProviders = Schema.Array(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

/**
 * Treat the optional `availability` as "available" when absent. This is
 * the rule legacy producers (which omit the field) and new producers
 * (which set it explicitly) agree on so consumers never have to thread
 * `?? "available"` defaults through their code paths.
 */
export const isProviderAvailable = (snapshot: ServerProvider): boolean =>
  snapshot.availability !== "unavailable";

export const ServerObservability = Schema.Struct({
  logsDirectoryPath: TrimmedNonEmptyString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesUrl: Schema.optional(TrimmedNonEmptyString),
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsUrl: Schema.optional(TrimmedNonEmptyString),
  otlpMetricsEnabled: Schema.Boolean,
});
export type ServerObservability = typeof ServerObservability.Type;

export const ServerTraceDiagnosticsErrorKind = Schema.Literals([
  "trace-file-not-found",
  "trace-file-read-failed",
]);
export type ServerTraceDiagnosticsErrorKind = typeof ServerTraceDiagnosticsErrorKind.Type;

export const ServerTraceDiagnosticsSpanSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  count: NonNegativeInt,
  failureCount: NonNegativeInt,
  totalDurationMs: Schema.Number,
  averageDurationMs: Schema.Number,
  maxDurationMs: Schema.Number,
});
export type ServerTraceDiagnosticsSpanSummary = typeof ServerTraceDiagnosticsSpanSummary.Type;

export const ServerTraceDiagnosticsFailureSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  count: NonNegativeInt,
  lastSeenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsFailureSummary = typeof ServerTraceDiagnosticsFailureSummary.Type;

export const ServerTraceDiagnosticsRecentFailure = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  durationMs: Schema.Number,
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsRecentFailure = typeof ServerTraceDiagnosticsRecentFailure.Type;

export const ServerTraceDiagnosticsSpanOccurrence = Schema.Struct({
  name: TrimmedNonEmptyString,
  durationMs: Schema.Number,
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsSpanOccurrence = typeof ServerTraceDiagnosticsSpanOccurrence.Type;

export const ServerTraceDiagnosticsLogEvent = Schema.Struct({
  spanName: TrimmedNonEmptyString,
  level: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  seenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsLogEvent = typeof ServerTraceDiagnosticsLogEvent.Type;

export const ServerTraceDiagnosticsResult = Schema.Struct({
  traceFilePath: TrimmedNonEmptyString,
  scannedFilePaths: Schema.Array(TrimmedNonEmptyString),
  readAt: Schema.DateTimeUtc,
  recordCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  firstSpanAt: Schema.Option(Schema.DateTimeUtc),
  lastSpanAt: Schema.Option(Schema.DateTimeUtc),
  failureCount: NonNegativeInt,
  interruptionCount: NonNegativeInt,
  slowSpanThresholdMs: NonNegativeInt,
  slowSpanCount: NonNegativeInt,
  logLevelCounts: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
  topSpansByCount: Schema.Array(ServerTraceDiagnosticsSpanSummary),
  slowestSpans: Schema.Array(ServerTraceDiagnosticsSpanOccurrence),
  commonFailures: Schema.Array(ServerTraceDiagnosticsFailureSummary),
  latestFailures: Schema.Array(ServerTraceDiagnosticsRecentFailure),
  latestWarningAndErrorLogs: Schema.Array(ServerTraceDiagnosticsLogEvent),
  partialFailure: Schema.Option(Schema.Boolean),
  error: Schema.Option(
    Schema.Struct({
      kind: ServerTraceDiagnosticsErrorKind,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerTraceDiagnosticsResult = typeof ServerTraceDiagnosticsResult.Type;

export const ServerProcessSignal = Schema.Literals(["SIGINT", "SIGKILL"]);
export type ServerProcessSignal = typeof ServerProcessSignal.Type;

export const ServerProcessDiagnosticsEntry = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  pgid: Schema.Option(Schema.Int),
  status: TrimmedNonEmptyString,
  cpuPercent: Schema.Number,
  rssBytes: NonNegativeInt,
  elapsed: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  childPids: Schema.Array(PositiveInt),
});
export type ServerProcessDiagnosticsEntry = typeof ServerProcessDiagnosticsEntry.Type;

export const ServerProcessDiagnosticsResult = Schema.Struct({
  serverPid: PositiveInt,
  readAt: Schema.DateTimeUtc,
  processCount: NonNegativeInt,
  totalRssBytes: NonNegativeInt,
  totalCpuPercent: Schema.Number,
  processes: Schema.Array(ServerProcessDiagnosticsEntry),
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessDiagnosticsResult = typeof ServerProcessDiagnosticsResult.Type;

export const ServerProcessResourceHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
});
export type ServerProcessResourceHistoryInput = typeof ServerProcessResourceHistoryInput.Type;

export const ServerProcessResourceHistoryBucket = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  maxRssBytes: NonNegativeInt,
  maxProcessCount: NonNegativeInt,
});
export type ServerProcessResourceHistoryBucket = typeof ServerProcessResourceHistoryBucket.Type;

export const ServerProcessResourceHistorySummary = Schema.Struct({
  processKey: TrimmedNonEmptyString,
  pid: PositiveInt,
  ppid: NonNegativeInt,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  isServerRoot: Schema.Boolean,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  currentCpuPercent: Schema.Number,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  cpuSecondsApprox: Schema.Number,
  currentRssBytes: NonNegativeInt,
  maxRssBytes: NonNegativeInt,
  sampleCount: NonNegativeInt,
});
export type ServerProcessResourceHistorySummary = typeof ServerProcessResourceHistorySummary.Type;

export const ServerProcessResourceHistoryFailureTag = Schema.Literals([
  "ProcessDiagnosticsQueryTimeoutError",
  "ProcessDiagnosticsQueryFailedError",
  "ProcessDiagnosticsServerProcessSignalError",
  "ProcessDiagnosticsNotDescendantError",
  "ProcessDiagnosticsSignalFailedError",
]);
export type ServerProcessResourceHistoryFailureTag =
  typeof ServerProcessResourceHistoryFailureTag.Type;

export const ServerProcessResourceHistoryResult = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  totalCpuSecondsApprox: Schema.Number,
  buckets: Schema.Array(ServerProcessResourceHistoryBucket),
  topProcesses: Schema.Array(ServerProcessResourceHistorySummary),
  error: Schema.Option(
    Schema.Struct({
      failureTag: ServerProcessResourceHistoryFailureTag,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessResourceHistoryResult = typeof ServerProcessResourceHistoryResult.Type;

export const ServerSignalProcessInput = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
});
export type ServerSignalProcessInput = typeof ServerSignalProcessInput.Type;

export const ServerSignalProcessResult = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
  signaled: Schema.Boolean,
  message: Schema.Option(TrimmedNonEmptyString),
});
export type ServerSignalProcessResult = typeof ServerSignalProcessResult.Type;

// Workstream worktrees maintenance surface (phase 3 visibility panel).
// The wire vocabulary mirrors the server's `worktreeClassification` truth:
// one disposition, plus a stale reason when the auto-reaper deliberately
// declined to remove the worktree. The UI maps these to human labels.
export const WorkstreamWorktreeDisposition = Schema.Literals(["active", "reapable", "stale"]);
export type WorkstreamWorktreeDisposition = typeof WorkstreamWorktreeDisposition.Type;

export const WorkstreamWorktreeStaleReason = Schema.Literals([
  "orphaned",
  "unmanaged",
  "cancelled",
  "conflicted",
  "fanin-pending",
  "dirty",
  "unmerged",
  "recently-finished",
]);
export type WorkstreamWorktreeStaleReason = typeof WorkstreamWorktreeStaleReason.Type;

export const WorkstreamWorktreeOwner = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  role: Schema.NullOr(TrimmedNonEmptyString),
});
export type WorkstreamWorktreeOwner = typeof WorkstreamWorktreeOwner.Type;

export const WorkstreamWorktreeEntry = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  isMain: Schema.Boolean,
  disposition: WorkstreamWorktreeDisposition,
  // Present exactly when disposition is `stale`.
  reason: Schema.NullOr(WorkstreamWorktreeStaleReason),
  // Null when no projection thread claims the path (a crash orphan).
  owner: Schema.NullOr(WorkstreamWorktreeOwner),
  // ms since the owner's last activity, else since the directory mtime.
  ageMs: Schema.NullOr(NonNegativeInt),
  // Branch fully merged into the parent branch; null when unknown/detached.
  merged: Schema.NullOr(Schema.Boolean),
  // Uncommitted changes (unknown dirty state is reported conservatively as dirty).
  dirty: Schema.Boolean,
  // Added by the query layer via `du`; null when sizing timed out or is unavailable.
  sizeBytes: Schema.NullOr(NonNegativeInt),
});
export type WorkstreamWorktreeEntry = typeof WorkstreamWorktreeEntry.Type;

export const WorkstreamWorktreesResult = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  entries: Schema.Array(WorkstreamWorktreeEntry),
});
export type WorkstreamWorktreesResult = typeof WorkstreamWorktreesResult.Type;

export const WorkstreamRemoveWorktreeInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  // Per-fact acknowledgements, not a blanket force: the server re-classifies
  // and refuses when the live state is riskier than what the human confirmed.
  acknowledgeDirty: Schema.optional(Schema.Boolean),
  acknowledgeUnmerged: Schema.optional(Schema.Boolean),
});
export type WorkstreamRemoveWorktreeInput = typeof WorkstreamRemoveWorktreeInput.Type;

export const WorkstreamRemoveWorktreeResult = Schema.Struct({
  removed: Schema.Boolean,
  // The `ws/…` branch, when it was deleted (only ever when fully merged).
  deletedBranch: Schema.NullOr(TrimmedNonEmptyString),
  // A refusal reason or failure detail; null on a clean removal.
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type WorkstreamRemoveWorktreeResult = typeof WorkstreamRemoveWorktreeResult.Type;

// `/handoff` fork-drafter (plan D2/D4): the human's composer intercept sends
// this application operation; the message never becomes a turn on the source.
// The server forks the source into a throwaway `handoff-drafter` root and
// injects the drafter kickoff as its first turn.
export const HandoffDraftInput = Schema.Struct({
  sourceThreadId: ThreadId,
  explanation: TrimmedNonEmptyString,
});
export type HandoffDraftInput = typeof HandoffDraftInput.Type;

export const HandoffDraftResult = Schema.Struct({
  drafterThreadId: ThreadId,
});
export type HandoffDraftResult = typeof HandoffDraftResult.Type;

// `/retro` fork-reviewer: the human's composer intercept sends this application
// operation; the message never becomes a turn on the source. The server forks
// the source into a VISIBLE `retro-reviewer` root and injects the retro kickoff
// as its first turn. `focus` is optional free-text narrowing the review.
export const RetroDraftInput = Schema.Struct({
  sourceThreadId: ThreadId,
  focus: Schema.optional(TrimmedNonEmptyString),
});
export type RetroDraftInput = typeof RetroDraftInput.Type;

export const RetroDraftResult = Schema.Struct({
  reviewerThreadId: ThreadId,
});
export type RetroDraftResult = typeof RetroDraftResult.Type;

// Static meter → backend-provider-id map. A meter scope key is a gauge account
// key (`providerInstanceId ?? providerName`); the poller emits "claudeAgent" for
// the Anthropic OAuth subscription meter and "codex" for the Codex subscription.
// Ledger rows carry the model's REAL backend in `provider_id` (the `providerID`
// half of pi/OpenCode's `providerID/modelID` slug). Each meter maps to the
// backend provider ids its subscription OFFICIALLY meters (counts toward its
// %). This single map is the source of truth for three things that must not
// drift: (1) which gauge card attaches to a per-backend scope tab, (2) the
// "not counted in any meter" (meterless) badge — anything not listed here is
// pay-per-use, and (3) the server-side row filter for a legacy meter-key scope.
// This is what fixes the Codex tab: gpt-* usage resolves to the OpenAI backend
// ids below, which the codex meter now matches. Vertex-served Claude and
// Bedrock are billed by Google/AWS, NOT the Anthropic OAuth subscription, so
// they are deliberately meterless — they appear as their own per-backend tabs
// with tracked burn but no official gauge (the user's Claude-on-Vertex vs
// Claude-on-Anthropic comparison lives at that per-backend granularity).
export const USAGE_METER_PROVIDER_NAMES: Record<string, ReadonlyArray<string>> = {
  claudeAgent: ["anthropic"],
  codex: ["openai-codex", "openai"],
};

// ── /usage dashboard breakdown (docs/usage-dashboard-design.md §3 D3) ─────────
// Pull RPC: aggregates the usage ledger over the selected provider window into
// gauges (official %), a stacked burn-chart series, a per-model table, and a
// per-thread consumers rollup. No push stream — the client refetches on a
// timer.
export const ServerUsageBreakdownInput = Schema.Struct({
  window: AccountUsageWindowKind, // "primary" (5h) | "secondary" (weekly)
  // Meter scope: a provider meter key (the gauge account key —
  // `providerInstanceId ?? providerName`) or "all". A meter key both fixes the
  // window boundaries and filters ledger rows to that meter's driver kinds via
  // the static meter → provider-name map (§D6). "all" applies no row filter and
  // uses the default provider's boundaries. Omitted ⇒ first provider with data.
  scope: Schema.optional(TrimmedNonEmptyString),
});
export type ServerUsageBreakdownInput = typeof ServerUsageBreakdownInput.Type;

export const ServerUsageBreakdownGauge = Schema.Struct({
  providerName: TrimmedNonEmptyString,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  // Distinguishes pooled accounts within one instance (a router proxy pooling
  // several subscriptions). Absent ⇒ the instance's sole account. The gauge's
  // stable identity (React key, pill deep-link scope) is the storage key
  // `providerInstanceId ?? providerName` plus this label — see
  // `accountUsageStorageKey`; two pooled accounts therefore never collide.
  accountLabel: Schema.optional(TrimmedNonEmptyString),
  planType: Schema.NullOr(TrimmedNonEmptyString),
  usedPercent: Schema.Number, // official, verbatim from the provider meter
  resetsAt: Schema.NullOr(IsoDateTime),
  windowDurationMins: Schema.NullOr(Schema.Number),
  observedAt: IsoDateTime,
  // Model display name when this gauge meters a per-model carve-out (e.g. the
  // Anthropic `weekly_scoped` limit for "Fable"), so the card is labelled
  // distinctly from the account-wide weekly gauge. Absent ⇒ account-wide.
  scopeDisplayName: Schema.optional(TrimmedNonEmptyString),
  // Linear depletion projection from the official-% sample buffer; null when the
  // guards fail (§D4: <3 samples, <10 min span, non-positive slope, stale
  // samples, or the projected exhaustion lands after the reset).
  projectedExhaustionAt: Schema.NullOr(IsoDateTime),
  // Ledger backend provider ids this gauge's meter covers, declared on the
  // instance's usage-source config (e.g. ["cliproxy"]). Extends the static
  // meter → backend map for pooled/router meters. Absent ⇒ static map only.
  meteredProviderIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type ServerUsageBreakdownGauge = typeof ServerUsageBreakdownGauge.Type;

export const ServerUsageBreakdownSeriesBucket = Schema.Struct({
  bucketStart: IsoDateTime,
  byModel: Schema.Record(Schema.String, Schema.Number), // model → cost in bucket (USD)
});
export type ServerUsageBreakdownSeriesBucket = typeof ServerUsageBreakdownSeriesBucket.Type;

export const ServerUsageBreakdownModel = Schema.Struct({
  model: Schema.String, // requested slug; "unknown" when absent
  // Real backend provider id (e.g. "google-vertex-claude", "openai-codex");
  // "unknown" for historical rows recorded before backend attribution.
  providerId: TrimmedNonEmptyString,
  inputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.Number,
  costShare: Schema.Number, // 0–1 of the scoped window cost
});
export type ServerUsageBreakdownModel = typeof ServerUsageBreakdownModel.Type;

export const ServerUsageBreakdownConsumer = Schema.Struct({
  // Flat rows; the client groups by rootThreadId and expands children.
  threadId: ThreadId,
  rootThreadId: ThreadId,
  title: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
  totalTokens: Schema.Number,
  costUsd: Schema.Number,
  turnCount: Schema.Number, // distinct turn_ids in window
  lastActivityAt: IsoDateTime,
});
export type ServerUsageBreakdownConsumer = typeof ServerUsageBreakdownConsumer.Type;

export class ServerUsageBreakdownError extends Schema.TaggedErrorClass<ServerUsageBreakdownError>()(
  "ServerUsageBreakdownError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ServerUsageBreakdownResult = Schema.Struct({
  window: AccountUsageWindowKind,
  scope: TrimmedNonEmptyString, // resolved scope key ("all" or a meter key)
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime, // reset time, or `now` in trailing mode
  boundarySource: Schema.Literals(["provider", "trailing"]),
  generatedAt: IsoDateTime,
  gauges: Schema.Array(ServerUsageBreakdownGauge),
  bucketMinutes: Schema.Number, // 5 for primary, 60 for secondary
  series: Schema.Array(ServerUsageBreakdownSeriesBucket),
  // Linear cost projection to the window end; null when elapsed < 15 min (§D4).
  projectedCostAtReset: Schema.NullOr(Schema.Number),
  models: Schema.Array(ServerUsageBreakdownModel),
  consumers: Schema.Array(ServerUsageBreakdownConsumer),
  // Real backend provider ids present in the window, cost-descending, IGNORING
  // the scope filter — the stable inventory the client unions with gauge-backed
  // backends to auto-derive the per-backend scope tabs. NULL-provider (historical)
  // rows are excluded; they surface only under "all".
  providers: Schema.Array(
    Schema.Struct({ providerId: TrimmedNonEmptyString, costUsd: Schema.Number }),
  ),
});
export type ServerUsageBreakdownResult = typeof ServerUsageBreakdownResult.Type;

export const ServerConfig = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  auth: ServerAuthDescriptor,
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: Schema.Array(EditorId),
  /**
   * SSH host the client uses to reach this server, for client-launched editors
   * (see CLIENT_LAUNCH_EDITORS). Null on a local install.
   */
  remoteEditorSshHost: Schema.NullOr(TrimmedNonEmptyString),
  observability: ServerObservability,
  settings: ServerSettings,
  /** Whether shell subscriptions can emit an opt-in catch-up completion marker. */
  shellResumeCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /** Whether thread subscriptions can emit an opt-in catch-up completion marker. */
  threadResumeCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type ServerConfig = typeof ServerConfig.Type;

const ServerUpsertKeybindingReplaceTarget = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});

export const ServerUpsertKeybindingInput = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
  replace: Schema.optional(ServerUpsertKeybindingReplaceTarget),
});
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerRemoveKeybindingInput = ServerUpsertKeybindingReplaceTarget;
export type ServerRemoveKeybindingInput = typeof ServerRemoveKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerRemoveKeybindingResult = ServerUpsertKeybindingResult;
export type ServerRemoveKeybindingResult = typeof ServerRemoveKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

export const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

// Live, account-scoped subscription usage (5-hour + weekly limits). Ephemeral
// global server state — repopulated from the next provider event after a
// restart — so it rides the existing config/lifecycle channel rather than the
// event-sourced orchestration projection. The payload carries the full current
// per-instance snapshot list (replace-on-emit; no client-side merge needed).
export const ServerConfigAccountUsagePayload = Schema.Struct({
  usage: Schema.Array(AccountUsageSnapshot),
});
export type ServerConfigAccountUsagePayload = typeof ServerConfigAccountUsagePayload.Type;

export const ServerConfigStreamAccountUsageEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("accountUsage"),
  payload: ServerConfigAccountUsagePayload,
});
export type ServerConfigStreamAccountUsageEvent = typeof ServerConfigStreamAccountUsageEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamAccountUsageEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerProviderUpdateInput = Schema.Struct({
  provider: ProviderDriverKind,
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ServerProviderUpdateInput = typeof ServerProviderUpdateInput.Type;

export class ServerProviderUpdateError extends Schema.TaggedErrorClass<ServerProviderUpdateError>()(
  "ServerProviderUpdateError",
  {
    provider: ProviderDriverKind,
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider update failed for ${this.provider}: ${this.reason}`;
  }
}

export const ServerSelfUpdateInput = Schema.Struct({
  /** Exact npm version of the `t3` package to install (never a dist-tag, so
      the server and the acknowledging client agree on what was requested). */
  targetVersion: TrimmedNonEmptyString,
});
export type ServerSelfUpdateInput = typeof ServerSelfUpdateInput.Type;

/** Acknowledgement that the update artifact is installed and the server is
    about to restart into it — the connection will drop moments later. */
export const ServerSelfUpdateResult = Schema.Struct({
  targetVersion: TrimmedNonEmptyString,
  method: ServerSelfUpdateMethod,
});
export type ServerSelfUpdateResult = typeof ServerSelfUpdateResult.Type;

export class ServerSelfUpdateError extends Schema.TaggedErrorClass<ServerSelfUpdateError>()(
  "ServerSelfUpdateError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server update failed: ${this.reason}`;
  }
}
