import {
  AttentionReason,
  CommandId,
  DEFAULT_GATE_MAX_ROUNDS,
  MAX_GATE_MAX_ROUNDS,
  MessageId,
  ModelSelection,
  TaskShape,
  ThreadId,
  ThreadIsolation,
  ThreadPlanLane,
  isProviderAvailable,
  type AccountUsageSnapshot,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProfileUnsuitableFor,
  type ServerProvider,
  type WorkstreamModelProfile,
  type WorkstreamRoute,
} from "@t3tools/contracts";
import { accountUsageRoutingKey } from "@t3tools/shared/accountUsage";
import { findDependencyCycle } from "@t3tools/shared/workstreamDependencies";
import { roleDefaultIsolation } from "@t3tools/shared/workstreamIsolation";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  gateLoopTargetOf,
  gateSourceFor,
  graphViewFor,
  requiresSubmitToComplete,
  routeWorkSubmit,
  subtreeOf,
} from "@t3tools/shared/workstreamGraph";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { askWorkstreamThread } from "../orchestration/workstreamAsk.ts";
import {
  isUnambiguousMatch,
  rankThreadsByName,
  resolveSessionFilePath,
} from "../orchestration/threadResolve.ts";
import { writeWorkstreamReport } from "../orchestration/workstreamReport.ts";
import { readWorkstreamBriefAt, writeWorkstreamBrief } from "../orchestration/workstreamBrief.ts";
import { kickoffTextForPrompt } from "../orchestration/workstreamChildPrompt.ts";
// loom: forkFrom (D7/D8) — undelivered-kickoff detection + fork-source-idle guard.
import { isKickoffDelivered } from "../orchestration/workstreamLaunchIdentity.ts";
import { shouldRefuseForkLaunch } from "../orchestration/threadIdle.ts";
import { piSessionIdForThread } from "../provider/piSessionFiles.ts";
import { AccountUsageRegistry } from "../provider/Services/AccountUsageRegistry.ts";
import {
  aggregateAccountsBestRemaining,
  ProviderHealthRegistry,
} from "../provider/Services/ProviderHealthRegistry.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  formatResetHint,
  subscriptionScopeForSelection,
  usageSourceInstances,
} from "../provider/exhaustionMapping.ts";
import { resolveFailoverTarget } from "../provider/failoverChains.ts";
import { exhaustionPredicate, piCatalogueFromProviders } from "../provider/failoverRouting.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveWorkstreamScope } from "./httpScope.ts";
import { PROVIDER_TOOL_PATHS } from "./toolPaths.ts";
import {
  appendWarnings,
  renderConsultCandidates,
  renderNotifyCandidates,
  renderNotifyDisposition,
  renderSubmitOutcome,
  renderWorkstreamList,
  type ConsultCandidate,
} from "./workstreamRender.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type * as PlatformError from "effect/PlatformError";
import {
  NOTIFY_MESSAGE_MAX_CHARS,
  notifyDeliverCommandId,
  notifyMarkCommandId,
  notifyRecordCommandId,
} from "@t3tools/shared/notify";

interface WorkstreamSpawnRequest {
  readonly role?: unknown;
  readonly purpose?: unknown;
  readonly brief?: unknown;
  readonly title?: unknown;
  readonly blockedBy?: unknown;
  readonly modelSelection?: unknown;
  readonly modelPreset?: unknown;
  readonly taskShape?: unknown;
  readonly sensitive?: unknown;
  readonly staged?: unknown;
  readonly gate?: unknown;
  readonly isolation?: unknown;
  // loom: forkFrom — source thread whose pi session this child forks at launch.
  readonly forkFrom?: unknown;
}

interface WorkstreamScaffoldNodeRequest {
  readonly key?: unknown;
  readonly role?: unknown;
  readonly purpose?: unknown;
  readonly title?: unknown;
  readonly blockedBy?: unknown;
  readonly modelSelection?: unknown;
  readonly modelPreset?: unknown;
  readonly taskShape?: unknown;
  readonly sensitive?: unknown;
  readonly gate?: unknown;
  readonly isolation?: unknown;
  // loom: forkFrom — key | thread:id of the source node/child to fork from.
  readonly forkFrom?: unknown;
}

interface WorkstreamScaffoldRequest {
  readonly staged?: unknown;
  readonly nodes?: unknown;
}

interface WorkstreamBriefRequest {
  readonly node?: unknown;
  readonly markdown?: unknown;
}

interface WorkstreamLaneRequest {
  readonly threadId?: unknown;
  readonly planLane?: unknown;
}

interface WorkstreamAttentionRequest {
  readonly threadId?: unknown;
  readonly reason?: unknown;
}

interface WorkstreamTargetRequest {
  readonly threadId?: unknown;
}

interface WorkstreamPromptRequest {
  readonly threadId?: unknown;
  readonly message?: unknown;
}

interface WorkstreamDependenciesRequest {
  readonly threadId?: unknown;
  readonly blockedBy?: unknown;
}

interface WorkstreamSubmitRequest {
  readonly markdown?: unknown;
  readonly outcome?: unknown;
  readonly contested?: unknown;
  readonly counts?: unknown;
}

interface WorkstreamConsultThreadRequest {
  readonly threadId?: unknown;
  readonly name?: unknown;
  readonly question?: unknown;
}

interface NotifyThreadRequest {
  readonly threadId?: unknown;
  readonly name?: unknown;
  readonly message?: unknown;
}

interface SetThreadTitleRequest {
  readonly title?: unknown;
}

// Server-side guard on a single fork turn (forking handles transcript size, so
// only the turn duration and the question length need bounding).
const ASK_TIMEOUT_MS = 120_000;
const ASK_QUESTION_MAX_CHARS = 8_000;
// Cap candidates surfaced on an ambiguous name so the agent gets a focused
// disambiguation set rather than the whole server's thread list.
const CONSULT_CANDIDATE_LIMIT = 8;

// Plan lanes an agent may set (the `workstream_set_lane` enum). `in_progress` is
// control-plane-only (set by starting a turn) and is excluded; the decider also
// rejects an agent `in_progress`.
const SETTABLE_LANES: ReadonlyArray<ThreadPlanLane> = ["planned", "ready", "done", "cancelled"];
const VALID_LANES = new Set<ThreadPlanLane>(SETTABLE_LANES);
// Worktree isolation (design §1): spawn-overridable policy. `attached` is not
// directly settable — it is the control-plane default for a gated reviewer.
const SPAWN_ISOLATIONS: ReadonlyArray<ThreadIsolation> = ["isolated", "shared"];
const VALID_SPAWN_ISOLATIONS = new Set<ThreadIsolation>(SPAWN_ISOLATIONS);
// Attention reasons an agent may raise. `error` is server-only and the two
// `awaiting_*` request reasons are derived from open requests — the decider
// rejects all three; this mirrors that set at the boundary.
const RAISABLE_REASONS: ReadonlyArray<AttentionReason> = ["awaiting_acceptance", "needs_guidance"];
const VALID_REASONS = new Set<AttentionReason>(RAISABLE_REASONS);

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });

// notify_thread (D5): the recipient's relationship to the sender, computed from
// `parentThreadId` on both ends. Global scope means the sender may be the
// target's actual parent OR one of its children, so the framing states the
// relationship rather than asserting a neutral peer.
export type NotifyRelationship =
  | "your parent orchestrator"
  | "one of your sub-threads"
  | "no parent/child relationship to you";

export const notifyRelationshipLabel = (input: {
  readonly senderThreadId: string;
  readonly senderParentThreadId: string | null;
  readonly targetThreadId: string;
  readonly targetParentThreadId: string | null;
}): NotifyRelationship =>
  input.targetParentThreadId === input.senderThreadId
    ? "your parent orchestrator"
    : input.senderParentThreadId === input.targetThreadId
      ? "one of your sub-threads"
      : "no parent/child relationship to you";

// notify_thread (D5): the relationship-aware wrapper landed in the recipient's
// transcript, composed + persisted at record time so the bytes are stable
// regardless of when the rail delivers. No em dashes (shipped-string style).
export const composeNotifyFramedText = (input: {
  readonly senderTitle: string;
  readonly senderRole: string;
  readonly senderThreadId: string;
  readonly relationship: NotifyRelationship;
  readonly message: string;
}): string =>
  `Notification from thread «${input.senderTitle}» (${input.senderRole}, ${input.senderThreadId}; ${input.relationship}), sent via notify_thread:\n\n` +
  `${input.message}\n\n` +
  `No reply is owed. If this needs no action from you, absorb it and continue your work. If the sender asked for something back, reply with notify_thread (threadId: ${input.senderThreadId}).`;

// consult_thread: the asker descriptor stitched into the fork's question turn.
// The HTTP layer owns WHO is asking (the credential's thread + the graph);
// `workstreamAsk` owns the read-only contract and does the composing. Consult is
// global like notify, so the relationship is stated rather than assumed, and the
// same label vocabulary is reused.
export const composeConsultAsker = (input: {
  readonly askerTitle: string;
  readonly askerRole: string;
  readonly askerThreadId: string;
  readonly relationship: NotifyRelationship;
}): string =>
  `thread «${input.askerTitle}» (${input.askerRole}, ${input.askerThreadId}; ${input.relationship})`;

const trimString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * D3 authorisation: a credential may mutate status/deps only on its OWN thread
 * or a thread it directly parents. Returns an error response when the target is
 * missing or out of scope, otherwise undefined (authorised).
 */
const authorizationError = Effect.fn("WorkstreamHttp.authorize")(function* (
  scopeThreadId: ThreadId,
  targetThreadId: ThreadId,
) {
  if (targetThreadId === scopeThreadId) return undefined;
  const projection = yield* ProjectionSnapshotQuery;
  const target = yield* projection.getThreadDetailById(targetThreadId);
  if (Option.isNone(target)) return jsonError(404, "Target thread was not found.");
  return target.value.parentThreadId === scopeThreadId
    ? undefined
    : jsonError(403, "Credential may only act on its own thread or a thread it directly parents.");
});

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

/**
 * Resolution of a child's model selection when no explicit `modelSelection` was
 * supplied (steps 2–4 of the spawn precedence). An explicit, decoded selection
 * always wins and is handled in the caller before this runs.
 */
/** Where a resolved `ModelSelection` came from — drives the validation error prose. */
export type SelectionSource =
  | { readonly kind: "explicit" }
  | { readonly kind: "preset"; readonly name: string }
  | { readonly kind: "role-preset"; readonly role: string }
  | { readonly kind: "task-shape"; readonly shape: TaskShape; readonly rationale: string }
  | { readonly kind: "inherited" };

export type PresetResolution =
  | {
      readonly kind: "selection";
      readonly selection: ModelSelection;
      readonly source: SelectionSource;
    }
  | {
      readonly kind: "unknown-preset";
      readonly modelPreset: string;
      readonly available: ReadonlyArray<string>;
    };

/**
 * Named-preset / role-default resolution against a single keyed map:
 *   2. `modelPreset` present → the named preset, or an unknown-preset error.
 *   3. else a preset keyed by `role` → use it.
 *   4. else inherit the parent's selection.
 */
export const resolvePresetSelection = (input: {
  readonly presets: Record<string, ModelSelection>;
  readonly modelPreset: string | undefined;
  readonly role: string;
  readonly parentSelection: ModelSelection;
}): PresetResolution => {
  if (input.modelPreset !== undefined) {
    const preset = input.presets[input.modelPreset];
    return preset === undefined
      ? {
          kind: "unknown-preset",
          modelPreset: input.modelPreset,
          available: Object.keys(input.presets),
        }
      : {
          kind: "selection",
          selection: preset,
          source: { kind: "preset", name: input.modelPreset },
        };
  }
  const rolePreset = input.presets[input.role];
  return rolePreset !== undefined
    ? {
        kind: "selection",
        selection: rolePreset,
        source: { kind: "role-preset", role: input.role },
      }
    : { kind: "selection", selection: input.parentSelection, source: { kind: "inherited" } };
};

// ---------------------------------------------------------------------------
// Capability-based model selection by task SHAPE (plan §3–§4). Pure resolver
// beside resolvePresetSelection: filter → rank → headroom-bucket → catalogue-
// validate → categorical rationale. The per-shape tables ARE the specification.
// ---------------------------------------------------------------------------

export const TASK_SHAPES: ReadonlyArray<TaskShape> = ["explore", "thorough", "mechanical"];
const VALID_TASK_SHAPES = new Set<TaskShape>(TASK_SHAPES);

// Optional `sensitive` spawn marker → the profile `unsuitableFor` token it
// excludes (v1: a single mapping). A parent passing `sensitive: "security"`
// drops every profile carrying `security-sensitive` from the candidate set.
const SENSITIVE_EXCLUSIONS: Record<string, ProfileUnsuitableFor> = {
  security: "security-sensitive",
};
const VALID_SENSITIVITIES = new Set(Object.keys(SENSITIVE_EXCLUSIONS));

/** Headroom bucket for a shape-filtered candidate (plan §4). */
export type HeadroomBucket = "healthy" | "demoted" | "skipped";

// Usage data older than this (or absent) is UNKNOWN ⇒ healthy: never demote on
// stale/missing data (§4). Also the near-reset discount horizon — a binding
// window resetting within it is not binding (the child barely dispatches before
// it clears). The binding window's usedPercent at/above the demote threshold
// buckets a candidate as `demoted`.
const HEADROOM_STALE_MS = 15 * 60_000;
const HEADROOM_RESET_DISCOUNT_MS = 15 * 60_000;
const HEADROOM_DEMOTE_PERCENT = 90;

export interface ShapeHeadroomInput {
  readonly usage: ReadonlyArray<AccountUsageSnapshot>;
  readonly isExhausted: (accountKey: string, modelId: string) => boolean;
  readonly usageSourceInstances: ReadonlySet<string>;
  readonly nowMs: number;
}

/** A window resets within the near-future discount horizon (valid future only). */
const withinResetDiscount = (resetsAt: string | null, nowMs: number): boolean => {
  if (resetsAt === null) return false;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return false;
  const delta = resetMs - nowMs;
  return delta > 0 && delta <= HEADROOM_RESET_DISCOUNT_MS;
};

/**
 * The headroom bucket for one profile's selection (§4). `skipped` on an active
 * hard-exhaustion mark (which also covers Codex `limitReached`, surfaced as a
 * telemetry mark); `demoted` when the binding window is ≥90% and not about to
 * reset; `healthy` otherwise — INCLUDING missing/stale data (never demote on
 * unknown). Aggregation reuses the router's best-remaining view so a pooled
 * instance is only as exhausted as its freshest account; scope is restricted to
 * account-wide windows plus windows mapped to the selected model.
 */
export const headroomBucketFor = (
  selection: ModelSelection,
  input: ShapeHeadroomInput,
): HeadroomBucket => {
  const scope = subscriptionScopeForSelection(selection, input.usageSourceInstances);
  if (scope.accountKey === null) return "healthy"; // API-billed — no subscription window
  if (input.isExhausted(scope.accountKey, scope.modelId)) return "skipped";
  const snapshot = aggregateAccountsBestRemaining(input.usage).find(
    (s) => accountUsageRoutingKey(s) === scope.accountKey,
  );
  if (snapshot === undefined) return "healthy"; // missing data ⇒ unknown ⇒ healthy
  // Freshness gates EVERYTHING derived from the snapshot (§4): data older than
  // ~15 min (or an unparseable timestamp) is unknown ⇒ healthy. Only the ACTIVE
  // health-registry mark (checked above, TTL-bounded) may still skip on old
  // data; a raw snapshot has no TTL here, so honouring a stale `limitReached`
  // or a stale percent would recreate the stale-state failure the rule prevents.
  const observedMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedMs) || input.nowMs - observedMs > HEADROOM_STALE_MS) {
    return "healthy"; // stale ⇒ unknown ⇒ healthy
  }
  // Explicit provider hard-exhaustion flag on FRESH data (§4: skipped is an
  // active mark OR `limitReached`). best-remaining aggregation already ANDs it
  // across pooled accounts, so a set flag here means EVERY account is spent.
  if (snapshot.limitReached === true) return "skipped";
  // In-scope windows: account-wide (unscoped) + windows mapped to this model.
  // A window about to reset is discounted (not binding).
  const binding = snapshot.windows.filter(
    (window) =>
      (window.scope === undefined || window.scope.modelId === scope.modelId) &&
      !withinResetDiscount(window.resetsAt, input.nowMs),
  );
  const maxPercent = binding.reduce((max, window) => Math.max(max, window.usedPercent), -1);
  return maxPercent >= HEADROOM_DEMOTE_PERCENT ? "demoted" : "healthy";
};

export interface ScoredCandidate {
  readonly name: string;
  readonly profile: WorkstreamModelProfile;
}

// A sort directive over candidates. Scores sort descending; cost ascending.
type SortDirective = {
  readonly get: (candidate: ScoredCandidate) => number;
  readonly dir: "asc" | "desc";
};

const byScore = (key: keyof WorkstreamModelProfile["scores"]): SortDirective => ({
  get: (candidate) => candidate.profile.scores[key],
  dir: "desc",
});
const byCostInput: SortDirective = {
  get: (candidate) => candidate.profile.costPerMtok.input,
  dir: "asc",
};

interface ShapeResolver {
  readonly filter: (profile: WorkstreamModelProfile) => boolean;
  readonly sortKeys: ReadonlyArray<SortDirective>;
}

// Per-shape filter (floors) and ordering (§3). Oracle/unsuitableFor exclusions
// are applied separately (never shape-specific).
const SHAPE_RESOLVERS: Record<TaskShape, ShapeResolver> = {
  explore: {
    filter: (p) => p.agentic === "full" && p.scores.endurance >= 5,
    sortKeys: [byScore("goalOrientation"), byScore("horsepower"), byScore("thoroughness")],
  },
  thorough: {
    filter: (p) => p.agentic === "full",
    sortKeys: [byScore("thoroughness"), byScore("horsepower"), byScore("goalOrientation")],
  },
  mechanical: {
    filter: (p) => (p.agentic === "full" || p.agentic === "bounded") && p.scores.horsepower >= 5,
    sortKeys: [byCostInput, byScore("horsepower")],
  },
};

// Total order: the shape's keys, then the universal tie-breaks appended to every
// sort — costPerMtok.input ↑, then profile name ↑. Without a strict total order
// parallel spawns could flip-flop on runtime sort stability (§3).
const compareCandidates =
  (sortKeys: ReadonlyArray<SortDirective>) =>
  (a: ScoredCandidate, b: ScoredCandidate): number => {
    for (const key of sortKeys) {
      const av = key.get(a);
      const bv = key.get(b);
      if (av !== bv) return key.dir === "asc" ? av - bv : bv - av;
    }
    if (a.profile.costPerMtok.input !== b.profile.costPerMtok.input) {
      return a.profile.costPerMtok.input - b.profile.costPerMtok.input;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };

export type ShapeResolution =
  | {
      readonly kind: "selection";
      readonly selection: ModelSelection;
      readonly profileName: string;
      readonly bucket: HeadroomBucket;
      readonly rationale: string;
      readonly warnings: ReadonlyArray<string>;
    }
  | { readonly kind: "fall-through"; readonly warnings: ReadonlyArray<string> };

// Best-bucket-first: pick from `healthy`, else `demoted`, else `skipped` (§3
// step 3 — a nearly-exhausted right-shaped model beats refusing to spawn).
const BUCKET_ORDER: ReadonlyArray<HeadroomBucket> = ["healthy", "demoted", "skipped"];

// Categorical rationale only — no percentages/prices/scores in parent-facing
// text (§3 step 5; the design's own information boundary). Two independent
// clauses off the full bucketed decision: WHY a higher-ranked first choice was
// passed over (if any), then the PICK's own headroom caveat (if any).
const FIRST_CHOICE_LOSS: Record<HeadroomBucket, string> = {
  healthy: "first choice unavailable", // pick != top with a healthy top ⇒ top was catalogue-invalid
  demoted: "first choice on low headroom",
  skipped: "first choice exhausted",
};
const PICK_CAVEAT: Record<HeadroomBucket, string> = {
  healthy: "",
  demoted: "running on low headroom",
  skipped: "every shape match exhausted — the child waits for the earliest reset",
};
const shapeRationale = (input: {
  readonly pickName: string;
  readonly shape: TaskShape;
  readonly pickBucket: HeadroomBucket;
  readonly topName: string;
  readonly topBucket: HeadroomBucket;
}): string => {
  const notes = [
    input.pickName === input.topName ? "" : `${FIRST_CHOICE_LOSS[input.topBucket]} — substituted`,
    PICK_CAVEAT[input.pickBucket],
  ].filter((n) => n !== "");
  return `${input.pickName} (${input.shape}${notes.length > 0 ? `; ${notes.join("; ")}` : ""})`;
};

const invalidProfileReason = (
  validation: Exclude<ModelSelectionValidation, { readonly kind: "ok" }>,
): string =>
  validation.kind === "unknown-instance"
    ? `instance "${validation.instanceId}" is not configured`
    : `model "${validation.model}" is unknown for instance "${validation.instanceId}"`;

/**
 * The shape's filtered, totally-ordered candidate list (§3), BEFORE headroom
 * bucketing: oracle/`unsuitableFor` exclusions + the shape floors, ranked by the
 * shape keys plus universal tie-breaks. Exposed for the per-shape ranking
 * snapshot test (§6.7) so a score edit surfaces its routing consequences.
 */
export const rankShapeCandidates = (input: {
  readonly shape: TaskShape;
  readonly sensitive?: string | undefined;
  readonly profiles: Record<string, WorkstreamModelProfile>;
}): ReadonlyArray<ScoredCandidate> => {
  const exclusion =
    input.sensitive === undefined ? undefined : SENSITIVE_EXCLUSIONS[input.sensitive];
  const resolver = SHAPE_RESOLVERS[input.shape];
  const candidates = Object.entries(input.profiles)
    .map(([name, profile]) => ({ name, profile }))
    .filter(
      (candidate) =>
        candidate.profile.agentic !== "oracle" &&
        (exclusion === undefined || !(candidate.profile.unsuitableFor ?? []).includes(exclusion)) &&
        resolver.filter(candidate.profile),
    );
  return [...candidates].sort(compareCandidates(resolver.sortKeys));
};

/**
 * Resolve a task shape to a concrete selection (§3–§4). Empty profile map or an
 * empty filtered candidate set ⇒ `fall-through` with a warning (never a hard
 * failure — the shape is advisory; §3). A resolved pick is catalogue-validated
 * like presets; an invalid pick drops to the next in bucket order, recording a
 * per-skip warning so operator misconfiguration is never silent.
 */
export const resolveShapeSelection = (input: {
  readonly shape: TaskShape;
  readonly sensitive: string | undefined;
  readonly profiles: Record<string, WorkstreamModelProfile>;
  readonly catalogue: ReadonlyArray<ModelCatalogueEntry>;
  readonly headroom: ShapeHeadroomInput;
}): ShapeResolution => {
  if (Object.keys(input.profiles).length === 0) {
    return {
      kind: "fall-through",
      warnings: [
        `taskShape "${input.shape}" requested but no workstreamModelProfiles are configured (see docs/operations/model-profiles.md) — falling through to the role preset / inherited model.`,
      ],
    };
  }
  const ranked = rankShapeCandidates({
    shape: input.shape,
    sensitive: input.sensitive,
    profiles: input.profiles,
  });
  if (ranked.length === 0) {
    return {
      kind: "fall-through",
      warnings: [
        `taskShape "${input.shape}"${input.sensitive !== undefined ? ` (sensitive: ${input.sensitive})` : ""} matched no configured profile — falling through to the role preset / inherited model.`,
      ],
    };
  }
  const bucketed = ranked.map((candidate) => ({
    candidate,
    bucket: headroomBucketFor(candidate.profile.selection, input.headroom),
  }));
  // The top-ranked shape match (before headroom re-prioritises buckets) — the
  // parent's "first choice", used to explain a headroom-driven substitution.
  const top = bucketed[0]!;
  // Best non-empty bucket first, keeping the ranked order within each bucket.
  const ordered = BUCKET_ORDER.flatMap((bucket) =>
    bucketed.filter((entry) => entry.bucket === bucket),
  );
  const warnings: string[] = [];
  for (const entry of ordered) {
    const validation = validateModelSelection(entry.candidate.profile.selection, input.catalogue);
    if (validation.kind === "ok") {
      return {
        kind: "selection",
        selection: entry.candidate.profile.selection,
        profileName: entry.candidate.name,
        bucket: entry.bucket,
        rationale: shapeRationale({
          pickName: entry.candidate.name,
          shape: input.shape,
          pickBucket: entry.bucket,
          topName: top.candidate.name,
          topBucket: top.bucket,
        }),
        warnings,
      };
    }
    warnings.push(
      `skipped profile "${entry.candidate.name}" (invalid: ${invalidProfileReason(validation)}).`,
    );
  }
  return {
    kind: "fall-through",
    warnings: [
      ...warnings,
      `taskShape "${input.shape}" matched profile(s) but none reference a configured instance/model — falling through to the role preset / inherited model.`,
    ],
  };
};

/**
 * The spawn model-selection precedence + boundary decode as ONE pure function
 * (plan §3, §6.7): explicit > modelPreset > taskShape > role preset > inherit,
 * with `taskShape`/`sensitive` decoded from raw request values. Extracted from
 * the HTTP handler so the whole decision — 400s for schema-invalid tokens, the
 * shape-ignored-under-override warnings, the categorical rationale, and the
 * catalogue-invalid fallthrough — is unit-testable without an HTTP layer. The
 * handler performs only the async `modelSelection` decode and passes the result
 * in via {@link ExplicitSelectionDecode}.
 */
export interface ExplicitSelectionDecode {
  /** `body.modelSelection !== undefined` (an explicit selection was supplied). */
  readonly provided: boolean;
  /** The decoded selection, or undefined when absent OR the decode failed. */
  readonly decoded: ModelSelection | undefined;
}

export type SpawnModelResolution =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly selection: ModelSelection;
      readonly source: SelectionSource;
      readonly warnings: ReadonlyArray<string>;
    };

export const resolveSpawnModelSelection = (input: {
  readonly explicit: ExplicitSelectionDecode;
  readonly modelPreset: unknown;
  readonly taskShape: unknown;
  readonly sensitive: unknown;
  readonly presets: Record<string, ModelSelection>;
  readonly profiles: Record<string, WorkstreamModelProfile>;
  readonly catalogue: ReadonlyArray<ModelCatalogueEntry>;
  readonly presetNames: ReadonlyArray<string>;
  readonly role: string;
  readonly parentSelection: ModelSelection;
  readonly headroom: ShapeHeadroomInput;
}): SpawnModelResolution => {
  // Boundary decode (§3): a SUPPLIED but non-enum / empty / non-string value is
  // a schema-level typo ⇒ error. Absent ⇒ omitted (the normal path).
  let taskShape: TaskShape | undefined;
  if (input.taskShape !== undefined) {
    const shape = trimString(input.taskShape);
    if (shape === undefined || !VALID_TASK_SHAPES.has(shape as TaskShape)) {
      return { kind: "error", message: `taskShape must be one of: ${TASK_SHAPES.join(", ")}.` };
    }
    taskShape = shape as TaskShape;
  }
  let sensitive: string | undefined;
  if (input.sensitive !== undefined) {
    const value = trimString(input.sensitive);
    if (value === undefined || !VALID_SENSITIVITIES.has(value)) {
      return {
        kind: "error",
        message: `sensitive must be one of: ${[...VALID_SENSITIVITIES].join(", ")}.`,
      };
    }
    sensitive = value;
  }

  const warnings: string[] = [];
  const presetSelection = trimString(input.modelPreset);
  const roleOrInherit = (): { selection: ModelSelection; source: SelectionSource } => {
    const preset = resolvePresetSelection({
      presets: input.presets,
      modelPreset: undefined,
      role: input.role,
      parentSelection: input.parentSelection,
    });
    // modelPreset is undefined, so this is always a `selection`.
    return preset.kind === "selection"
      ? { selection: preset.selection, source: preset.source }
      : { selection: input.parentSelection, source: { kind: "inherited" } };
  };

  let resolved: { selection: ModelSelection; source: SelectionSource };
  if (input.explicit.provided) {
    if (input.explicit.decoded === undefined) {
      return { kind: "error", message: "modelSelection is invalid." };
    }
    resolved = { selection: input.explicit.decoded, source: { kind: "explicit" } };
    if (taskShape !== undefined) {
      warnings.push(
        `taskShape "${taskShape}" was ignored: an explicit modelSelection takes precedence.`,
      );
    }
  } else if (presetSelection !== undefined) {
    const preset = resolvePresetSelection({
      presets: input.presets,
      modelPreset: presetSelection,
      role: input.role,
      parentSelection: input.parentSelection,
    });
    if (preset.kind === "unknown-preset") {
      return { kind: "error", message: unknownPresetMessage(preset.modelPreset, preset.available) };
    }
    resolved = { selection: preset.selection, source: preset.source };
    if (taskShape !== undefined) {
      warnings.push(
        `taskShape "${taskShape}" was ignored: an explicit modelPreset takes precedence.`,
      );
    }
  } else if (taskShape !== undefined) {
    const shapeResult = resolveShapeSelection({
      shape: taskShape,
      sensitive,
      profiles: input.profiles,
      catalogue: input.catalogue,
      headroom: input.headroom,
    });
    warnings.push(...shapeResult.warnings);
    if (shapeResult.kind === "selection") {
      resolved = {
        selection: shapeResult.selection,
        source: { kind: "task-shape", shape: taskShape, rationale: shapeResult.rationale },
      };
      warnings.push(`model selected by shape: ${shapeResult.rationale}.`);
    } else {
      resolved = roleOrInherit();
    }
  } else {
    resolved = roleOrInherit();
  }

  // A configured preset / role default / shape profile can be stale and point at
  // an instance this build no longer ships — validate every non-inherited source
  // (a shape pick is already catalogue-checked inside the resolver; idempotent).
  // The inherited parent selection is trusted (the parent is live).
  if (resolved.source.kind !== "inherited") {
    const validation = validateModelSelection(resolved.selection, input.catalogue);
    if (validation.kind !== "ok") {
      return {
        kind: "error",
        message: invalidModelSelectionMessage(
          validation,
          input.catalogue,
          input.presetNames,
          resolved.source,
        ),
      };
    }
  }
  return { kind: "ok", selection: resolved.selection, source: resolved.source, warnings };
};

/**
 * Spawn-time exhaustion warning (§7, D6). The resolved selection is NEVER
 * rewritten — the child inherits intent and effective routing (chunk C) applies
 * the fallback per dispatch, reverting after reset. This only surfaces what will
 * happen so the orchestrator sees it in the tool result. When a healthy fallback
 * is resolved (shared {@link resolveFailoverTarget}), it is named; otherwise the
 * warning states the child will not start until the limit resets.
 */
export const buildSpawnExhaustionWarning = (input: {
  readonly slug: string;
  readonly resetHint: string;
  readonly fallbackTarget: string | undefined;
}): string =>
  input.fallbackTarget !== undefined
    ? `Resolved model ${input.slug} is exhausted (resets ${input.resetHint}); the child will run on fallback ${input.fallbackTarget} until ${input.slug} resets, then return to it.`
    : `Resolved model ${input.slug} is exhausted (resets ${input.resetHint}) and no healthy fallback is available; the child will not start until the limit resets ${input.resetHint} — it resumes automatically then.`;

type DependencySibling = {
  readonly id: ThreadId;
  readonly title: string | null;
  readonly role: string | null;
  readonly parentThreadId: ThreadId | null;
  readonly planLane: ThreadPlanLane;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  readonly session: unknown | null;
  readonly latestUserMessageAt: string | null;
};

export type SpawnGraphResult =
  | { readonly kind: "rejected"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly blockedBy: ReadonlyArray<ThreadId> | undefined;
      readonly forceAttached: boolean;
      readonly warnings: ReadonlyArray<string>;
    };

export interface SpawnGraphInput {
  readonly operation?: "spawn" | "set-dependencies";
  readonly siblings: ReadonlyArray<DependencySibling>;
  readonly archivedSiblings?: ReadonlyArray<DependencySibling>;
  readonly blockedBy: ReadonlyArray<ThreadId> | undefined;
  readonly gateRework: ThreadId | undefined;
  readonly gateMaxRounds?: number | undefined;
  // loom: forkFrom (D3) — the fork source's implied dependency (added to
  // blockedBy when absent). Mutually exclusive with gateRework at the handler.
  readonly forkFrom?: ThreadId | undefined;
  readonly isolationOverride: ThreadIsolation | undefined;
  readonly role: string;
  readonly newThreadId?: ThreadId;
  readonly target?: DependencySibling;
}

export const hasThreadStarted = (thread: {
  readonly session: unknown | null;
  readonly latestUserMessageAt: string | null;
}): boolean => thread.session !== null || thread.latestUserMessageAt !== null;

const uniqueIds = (ids: ReadonlyArray<ThreadId>): ReadonlyArray<ThreadId> => [...new Set(ids)];

const formatThread = (thread: Pick<DependencySibling, "id" | "title" | "planLane">): string =>
  `${thread.id} — "${thread.title ?? "(untitled)"}" (${thread.planLane})`;

const knownChildrenMessage = (siblings: ReadonlyArray<DependencySibling>): string =>
  siblings.length > 0 ? siblings.map(formatThread).join(", ") : "none";

const dependencyCycleMessage = (
  cycle: ReadonlyArray<ThreadId>,
  operation: "spawn" | "set-dependencies",
): string => {
  const path = cycle.join(" → ");
  return operation === "spawn"
    ? `blockedBy would place this child behind a dependency cycle: ${path}. A cyclic set never releases, so the child would never start. Fix the cycle first (workstream_set_dependencies on one of the members). Nothing was spawned.`
    : `These dependencies would create a cycle: ${path}. A cyclic set never releases — every member waits on another member forever. Remove one edge, or re-order the work. Nothing was changed.`;
};

export const validateSpawnGraph = (input: SpawnGraphInput): SpawnGraphResult => {
  const operation = input.operation ?? "spawn";
  if (
    operation === "spawn" &&
    input.gateMaxRounds !== undefined &&
    (!Number.isInteger(input.gateMaxRounds) ||
      input.gateMaxRounds < 1 ||
      input.gateMaxRounds > MAX_GATE_MAX_ROUNDS)
  ) {
    return {
      kind: "rejected",
      message: `gate.maxRounds must be an integer between 1 and ${MAX_GATE_MAX_ROUNDS}. Each round is a full rework + re-review cycle; if you expect to need more than a few, the work should be re-scoped instead of looped.`,
    };
  }
  if (operation === "set-dependencies" && input.target?.parentThreadId === null) {
    return {
      kind: "rejected",
      message:
        "Dependencies have no effect on a root thread — only sub-threads are dependency-gated. Nothing was changed.",
    };
  }

  const blockedBy = uniqueIds(input.blockedBy ?? []);
  if (operation === "set-dependencies" && input.target !== undefined) {
    if (blockedBy.includes(input.target.id)) {
      return {
        kind: "rejected",
        message: `A thread cannot block on itself (${input.target.id} is the target thread). Nothing was changed.`,
      };
    }
  }

  const validSiblings =
    operation === "set-dependencies" && input.target !== undefined
      ? input.siblings.filter((thread) => thread.id !== input.target!.id)
      : input.siblings;
  const activeById = new Map(validSiblings.map((thread) => [thread.id, thread] as const));
  const invalid = blockedBy.filter((id) => !activeById.has(id));
  if (invalid.length > 0) {
    const archivedById = new Map(
      (input.archivedSiblings ?? []).map((thread) => [thread.id, thread] as const),
    );
    const archived = invalid.flatMap((id) => {
      const thread = archivedById.get(id);
      return thread === undefined ? [] : [thread];
    });
    if (archived.length > 0) {
      const archivedIds = new Set(archived.map((thread) => thread.id));
      const otherInvalid = invalid.filter((id) => !archivedIds.has(id));
      return {
        kind: "rejected",
        message: `${operation === "spawn" ? "blockedBy names" : "Dependencies name"} ${archived.map((thread) => `${thread.id} ("${thread.title ?? "(untitled)"}")`).join(", ")}, which ${archived.length === 1 ? "is" : "are"} archived and no longer active — an archived thread cannot gate (depending on it would silently release). ${otherInvalid.length > 0 ? `Other invalid ids: ${otherInvalid.join(", ")}. ` : ""}Known active siblings: ${knownChildrenMessage(validSiblings)}. Depend on an active sibling instead. ${operation === "spawn" ? "Nothing was spawned." : "Nothing was changed."}`,
      };
    }
    return {
      kind: "rejected",
      message:
        operation === "spawn"
          ? `blockedBy contains ids that are not children of this thread: ${invalid.join(", ")}. A dependency can only name a sibling of the new child — a thread you directly parent. Known children: ${knownChildrenMessage(validSiblings)}. Use the exact childThreadId returned by workstream_spawn, or check workstream_list. Nothing was spawned.`
          : `blockedBy contains ids that are not siblings of the target thread: ${invalid.join(", ")}. A dependency can only name an active sibling of the target. Known siblings: ${knownChildrenMessage(validSiblings)}. Use the exact thread id from workstream_list. Nothing was changed.`,
    };
  }

  const warnings: Array<string> = [];
  let effectiveBlockedBy = blockedBy;
  let gateTarget: DependencySibling | undefined;
  if (operation === "spawn" && input.gateRework !== undefined) {
    gateTarget = activeById.get(input.gateRework);
    if (gateTarget === undefined) {
      const archived = (input.archivedSiblings ?? []).find(
        (thread) => thread.id === input.gateRework,
      );
      return {
        kind: "rejected",
        message:
          archived === undefined
            ? `gate.rework must name an active sibling: a thread this thread directly parents. Known children: ${knownChildrenMessage(validSiblings)}. Nothing was spawned.`
            : `gate.rework names ${archived.id} ("${archived.title ?? "(untitled)"}"), which is archived and no longer active — an archived thread cannot gate (depending on it would silently release). Depend on an active sibling instead. Nothing was spawned.`,
      };
    }
    if (!effectiveBlockedBy.includes(input.gateRework)) {
      effectiveBlockedBy = [...effectiveBlockedBy, input.gateRework];
      warnings.push(
        `gate.rework ${input.gateRework} was added to blockedBy automatically — a gated reviewer always waits for the thread it reviews.`,
      );
    }
    if (input.isolationOverride !== undefined) {
      warnings.push(
        `isolation "${input.isolationOverride}" was ignored: a gated reviewer always runs attached (it joins the reviewed thread's worktree). Any other isolation deadlocks the gate — the reviewer would wait for the coder's fan-in, which is deferred until the gate the reviewer itself must resolve.`,
      );
    }
    if (roleDefaultIsolation(gateTarget.role) !== "isolated") {
      warnings.push(
        `gate.rework targets ${gateTarget.id} ("${gateTarget.title ?? "(untitled)"}", role "${gateTarget.role ?? "thread"}") — a reader-style role. Review gates loop rework back to the thread that produces the work (coder/planner/free-text writer); gating a ${gateTarget.role ?? "thread"} is usually a wiring mistake. Proceeding anyway.`,
      );
    }
  }

  // loom: forkFrom (D3) — the implied dependency. A fork must wait for its
  // source to finish; the lane edge is what sequences the acknowledge-then-fork
  // pattern (D7 additionally gates the launch on the source being idle). Mirror
  // the gate.rework auto-add: append forkFrom to blockedBy when absent, with a
  // warning, and never double-add. gate + forkFrom is rejected at the handler,
  // so the two implied deps never both apply.
  if (operation === "spawn" && input.forkFrom !== undefined) {
    if (!activeById.has(input.forkFrom)) {
      return {
        kind: "rejected",
        message: `forkFrom must name an active sibling: a thread this thread directly parents. Known children: ${knownChildrenMessage(validSiblings)}. Nothing was spawned.`,
      };
    }
    if (!effectiveBlockedBy.includes(input.forkFrom)) {
      effectiveBlockedBy = [...effectiveBlockedBy, input.forkFrom];
      warnings.push(
        `forkFrom ${input.forkFrom} was added to blockedBy automatically — a fork waits for its source thread to finish before it launches.`,
      );
    }
  }

  for (const depId of effectiveBlockedBy) {
    const dep = activeById.get(depId);
    if (dep?.planLane === "cancelled") {
      warnings.push(
        `blockedBy names ${dep.id} ("${dep.title ?? "(untitled)"}"), which is cancelled. A cancelled dependency never releases — ${operation === "spawn" ? "this child" : "the target thread"} will not start unless ${dep.id} is revived (workstream_set_lane → ready) or ${operation === "spawn" ? "this child's" : "the target thread's"} dependencies are re-pointed.`,
      );
    }
  }

  const graphThreads =
    operation === "set-dependencies" && input.target !== undefined
      ? input.siblings.map((thread) =>
          thread.id === input.target!.id ? { ...thread, blockedBy: effectiveBlockedBy } : thread,
        )
      : [
          ...input.siblings,
          {
            id: input.newThreadId ?? ("__new_child__" as ThreadId),
            parentThreadId: input.siblings[0]?.parentThreadId ?? null,
            blockedBy: effectiveBlockedBy,
          },
        ];
  const cycle = findDependencyCycle(graphThreads);
  if (cycle !== null)
    return { kind: "rejected", message: dependencyCycleMessage(cycle, operation) };

  if (
    operation === "set-dependencies" &&
    input.target !== undefined &&
    hasThreadStarted(input.target)
  ) {
    warnings.push(
      `${input.target.id} has already started: the dependency edge was recorded for DISPLAY ONLY — a started thread is never un-run, so this will not pause or re-gate it. To pause it use workstream_stop; to abandon it set its lane to cancelled; to sequence future work, set blockedBy at spawn time.`,
    );
  }

  return {
    kind: "ok",
    blockedBy:
      input.blockedBy === undefined && effectiveBlockedBy.length === 0
        ? undefined
        : effectiveBlockedBy,
    forceAttached: operation === "spawn" && input.gateRework !== undefined,
    warnings,
  };
};

// Scaffold-first graph authoring (workstream-scaffold plan). A blockedBy /
// gate.rework reference in a scaffold is EITHER a symbolic node key (a batch
// node's key or an existing child's `graphKey`) OR an existing thread id written
// with the `thread:` prefix. Parsing is deterministic by contract: a
// `thread:`-prefixed string is always a thread id; everything else is a key; and
// a bare UUID-shaped key is rejected loudly (a thread id pasted without the
// prefix) rather than silently becoming a key.
const SCAFFOLD_THREAD_REF_PREFIX = "thread:";
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScaffoldRefResolution =
  | { readonly kind: "ok"; readonly id: ThreadId }
  | { readonly kind: "error"; readonly message: string };

/**
 * Resolve one scaffold reference string to a ThreadId. `keyToId` maps every
 * symbolic key the caller may reference (batch node keys + existing child
 * graphKeys) to its thread id; `existingIds` is the set of active existing
 * child ids a `thread:` reference may name. The decider re-validates the
 * resolved graph atomically — this is the handler's early, friendly resolution.
 */
export const resolveScaffoldReference = (input: {
  readonly ref: string;
  readonly keyToId: ReadonlyMap<string, ThreadId>;
  readonly existingIds: ReadonlySet<ThreadId>;
}): ScaffoldRefResolution => {
  const ref = input.ref.trim();
  if (ref.startsWith(SCAFFOLD_THREAD_REF_PREFIX)) {
    const id = ref.slice(SCAFFOLD_THREAD_REF_PREFIX.length).trim();
    if (id.length === 0) {
      return {
        kind: "error",
        message: `reference "${input.ref}" has an empty thread id after "thread:".`,
      };
    }
    if (!input.existingIds.has(id as ThreadId)) {
      return {
        kind: "error",
        message: `reference "${input.ref}" does not name an active existing child of this parent.`,
      };
    }
    return { kind: "ok", id: id as ThreadId };
  }
  if (UUID_SHAPED.test(ref)) {
    return {
      kind: "error",
      message: `reference "${ref}" is UUID-shaped but unprefixed — reference an existing thread with the "thread:" prefix, or use a symbolic key.`,
    };
  }
  const resolved = input.keyToId.get(ref);
  if (resolved === undefined) {
    return {
      kind: "error",
      message: `reference "${ref}" is neither a node key in this scaffold nor an existing child's key.`,
    };
  }
  return { kind: "ok", id: resolved };
};

// loom: forkFrom (D2/D4) — spawn/scaffold surface validation. These pure
// validators keep the fork identity rules (no role/model fields, pi-backed
// source resolved via provider instance metadata, active-direct-child scope,
// fork-edge acyclicity, order-independent fork-of-fork inheritance) testable in
// isolation, matching this module's validator/sibling-test convention.

/**
 * Provider driver kind per configured instance id. The D4 pi-backed check reads
 * this instead of `session.providerName` (rev-4 must-fix): an unlaunched source
 * — e.g. an in-batch reader — has no session, but its resolved
 * `modelSelection.instanceId` always maps to a driver here.
 */
export const instanceDriverKinds = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyMap<string, string> =>
  new Map(providers.map((provider) => [provider.instanceId, provider.driver as string]));

const FORK_IDENTITY_FIELDS = [
  "role",
  "modelSelection",
  "modelPreset",
  "taskShape",
  "sensitive",
] as const;

/**
 * D2: a fork inherits its source's launch identity, so none of role /
 * modelSelection / modelPreset / taskShape / sensitive may be combined with
 * forkFrom — each is rejected (never silently ignored). Returns the rejection
 * message when any offending field was provided, else undefined.
 */
export const forkIdentityFieldsRejection = (
  provided: Readonly<Record<(typeof FORK_IDENTITY_FIELDS)[number], boolean>>,
  nothingClause = "Nothing was spawned.",
): string | undefined => {
  const offenders = FORK_IDENTITY_FIELDS.filter((field) => provided[field]);
  if (offenders.length === 0) return undefined;
  const isOne = offenders.length === 1;
  return `${offenders.join(", ")} cannot be combined with forkFrom: a fork inherits its source's launch identity (role, applied model + thinking level), so ${isOne ? "that field is" : "those fields are"} rejected rather than silently ignored. Remove ${isOne ? "it" : "them"} — the fork adopts the source's role and model. ${nothingClause}`;
};

export const forkFromGateConflictMessage = (nothingClause = "Nothing was spawned."): string =>
  `gate and forkFrom cannot be combined: a forked child is a normal worker that inherits the source's session, not a gated reviewer — v1 does not compose the two (the attached-worktree promotion has no reasoned semantics here). Drop one. ${nothingClause}`;

/** Shared pi-backed rejection so spawn and scaffold read identically. */
export const forkSourceNotPiBackedMessage = (input: {
  readonly forkFrom: ThreadId;
  readonly title: string | null;
  readonly instanceId: string;
  readonly nothingClause: string;
}): string =>
  `forkFrom source ${input.forkFrom} ("${input.title ?? "(untitled)"}") runs on provider instance "${input.instanceId}", which is not pi-backed. Forking copies pi's native session transcript, so only a pi-backed source can be forked. ${input.nothingClause}`;

export interface ForkIdentity {
  readonly role: string | null;
  readonly modelSelection: ModelSelection;
}

export type ForkSourceResolution =
  | { readonly kind: "ok"; readonly id: ThreadId; readonly identity: ForkIdentity }
  | { readonly kind: "rejected"; readonly message: string };

interface ForkSourceSibling {
  readonly id: ThreadId;
  readonly title: string | null;
  readonly role: string | null;
  readonly modelSelection: ModelSelection;
}

/**
 * Resolve a workstream_spawn `forkFrom` to a validated source (D4): an active
 * direct child of the caller (archived → archived rejection; unknown → not-a-
 * child), pi-backed (provider instance metadata, NOT session.providerName), and
 * not the child being spawned. On success returns the source's inherited
 * identity (role + applied model selection).
 */
export const resolveForkSource = (input: {
  readonly forkFrom: ThreadId;
  readonly newChildId: ThreadId;
  readonly activeChildren: ReadonlyArray<ForkSourceSibling>;
  readonly archivedChildren: ReadonlyArray<{
    readonly id: ThreadId;
    readonly title: string | null;
  }>;
  readonly instanceDrivers: ReadonlyMap<string, string>;
}): ForkSourceResolution => {
  if (input.forkFrom === input.newChildId) {
    return {
      kind: "rejected",
      message: "forkFrom cannot name the child being spawned. Nothing was spawned.",
    };
  }
  const active = input.activeChildren.find((child) => child.id === input.forkFrom);
  if (active === undefined) {
    const archived = input.archivedChildren.find((child) => child.id === input.forkFrom);
    if (archived !== undefined) {
      return {
        kind: "rejected",
        message: `forkFrom names ${archived.id} ("${archived.title ?? "(untitled)"}"), which is archived and no longer active — an archived thread cannot be forked. Nothing was spawned.`,
      };
    }
    return {
      kind: "rejected",
      message: `forkFrom must name an active direct child of this thread — ${input.forkFrom} is not one. Known children: ${
        input.activeChildren.length > 0
          ? input.activeChildren
              .map((child) => `${child.id} ("${child.title ?? "(untitled)"}")`)
              .join(", ")
          : "none"
      }. Nothing was spawned.`,
    };
  }
  if (input.instanceDrivers.get(active.modelSelection.instanceId) !== "pi") {
    return {
      kind: "rejected",
      message: forkSourceNotPiBackedMessage({
        forkFrom: input.forkFrom,
        title: active.title,
        instanceId: active.modelSelection.instanceId,
        nothingClause: "Nothing was spawned.",
      }),
    };
  }
  return {
    kind: "ok",
    id: input.forkFrom,
    identity: { role: active.role, modelSelection: active.modelSelection },
  };
};

export interface ForkChainNode {
  readonly key: string;
  readonly id: ThreadId;
  /** Resolved source id (batch node id or existing child id), or undefined. */
  readonly forkFromId: ThreadId | undefined;
}

export type ForkChainResult =
  | { readonly kind: "error"; readonly nodeKey: string; readonly message: string }
  | { readonly kind: "ok"; readonly identityByKey: ReadonlyMap<string, ForkIdentity> };

/**
 * Phase 1 of the two-phase scaffold fork resolution (D4). Walks every fork
 * node's edge to its ultimate source in array-order-independent (topological)
 * fashion so a fork-of-a-fork inherits the same identity regardless of node
 * order, and rejects self-forks, fork-edge cycles, and non-pi sources with a
 * node-labelled error. `baseIdentityById` carries the concrete identity of
 * every NON-fork batch node (its own role + resolved modelSelection) and every
 * existing child a fork may point at. Returns the inherited identity of each
 * fork node keyed by node key.
 */
export const resolveForkChains = (input: {
  readonly nodes: ReadonlyArray<ForkChainNode>;
  readonly baseIdentityById: ReadonlyMap<ThreadId, ForkIdentity>;
  readonly instanceDrivers: ReadonlyMap<string, string>;
}): ForkChainResult => {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node] as const));
  const identityByKey = new Map<string, ForkIdentity>();
  const resolvedById = new Map<ThreadId, ForkIdentity>();
  const visiting = new Set<ThreadId>();
  let failure: { readonly nodeKey: string; readonly message: string } | undefined;

  const identityOf = (id: ThreadId): ForkIdentity | undefined => {
    const cached = resolvedById.get(id);
    if (cached !== undefined) return cached;
    const base = input.baseIdentityById.get(id);
    if (base !== undefined) return base;
    const node = nodeById.get(id);
    if (node === undefined || node.forkFromId === undefined) return undefined;
    return resolveFork(node);
  };

  const resolveFork = (node: ForkChainNode): ForkIdentity | undefined => {
    if (failure !== undefined) return undefined;
    const forkFromId = node.forkFromId;
    if (forkFromId === undefined) return input.baseIdentityById.get(node.id);
    if (forkFromId === node.id) {
      failure = {
        nodeKey: node.key,
        message: `node "${node.key}": forkFrom cannot name the node itself. Nothing was created.`,
      };
      return undefined;
    }
    const cached = resolvedById.get(node.id);
    if (cached !== undefined) return cached;
    if (visiting.has(node.id)) {
      failure = {
        nodeKey: node.key,
        message: `node "${node.key}": forkFrom forms a cycle (${node.key} → … → ${node.key}); a fork chain must terminate at a non-fork source. Nothing was created.`,
      };
      return undefined;
    }
    visiting.add(node.id);
    const sourceIdentity = identityOf(forkFromId);
    visiting.delete(node.id);
    if (failure !== undefined) return undefined;
    if (sourceIdentity === undefined) {
      // resolveScaffoldReference validated the ref, so this is unreachable in
      // the handler; kept as a loud guard rather than a silent undefined.
      failure = {
        nodeKey: node.key,
        message: `node "${node.key}": forkFrom source could not be resolved. Nothing was created.`,
      };
      return undefined;
    }
    if (input.instanceDrivers.get(sourceIdentity.modelSelection.instanceId) !== "pi") {
      failure = {
        nodeKey: node.key,
        message: `node "${node.key}": ${forkSourceNotPiBackedMessage({
          forkFrom: forkFromId,
          title: null,
          instanceId: sourceIdentity.modelSelection.instanceId,
          nothingClause: "Nothing was created.",
        })}`,
      };
      return undefined;
    }
    resolvedById.set(node.id, sourceIdentity);
    identityByKey.set(node.key, sourceIdentity);
    return sourceIdentity;
  };

  for (const node of input.nodes) {
    if (node.forkFromId === undefined) continue;
    resolveFork(node);
    if (failure !== undefined) {
      return { kind: "error", nodeKey: failure.nodeKey, message: failure.message };
    }
  }
  return { kind: "ok", identityByKey };
};

export type ScaffoldForkReferenceResolution =
  | { readonly kind: "ok"; readonly id: ThreadId }
  | { readonly kind: "error"; readonly message: string };

/**
 * Resolve a scaffold `forkFrom` reference (D4). Wraps `resolveScaffoldReference`
 * and, when a `thread:<id>` reference names an ARCHIVED existing child, returns
 * the archived-style rejection instead of the generic "not an active child"
 * message — so a source archived between authoring calls is distinguishable from
 * a wrong / non-child id. Every message is node-labelled and ends
 * "Nothing was created."
 */
export const resolveScaffoldForkReference = (input: {
  readonly ref: string;
  readonly nodeKey: string;
  readonly keyToId: ReadonlyMap<string, ThreadId>;
  readonly existingIds: ReadonlySet<ThreadId>;
  readonly archived: ReadonlyArray<{ readonly id: ThreadId; readonly title: string | null }>;
}): ScaffoldForkReferenceResolution => {
  const resolution = resolveScaffoldReference({
    ref: input.ref,
    keyToId: input.keyToId,
    existingIds: input.existingIds,
  });
  if (resolution.kind === "ok") return { kind: "ok", id: resolution.id };
  const ref = input.ref.trim();
  if (ref.startsWith(SCAFFOLD_THREAD_REF_PREFIX)) {
    const id = ref.slice(SCAFFOLD_THREAD_REF_PREFIX.length).trim() as ThreadId;
    const archived = input.archived.find((thread) => thread.id === id);
    if (archived !== undefined) {
      return {
        kind: "error",
        message: `node "${input.nodeKey}": forkFrom names ${archived.id} ("${archived.title ?? "(untitled)"}"), which is archived and no longer active — an archived thread cannot be forked. Nothing was created.`,
      };
    }
  }
  return {
    kind: "error",
    message: `node "${input.nodeKey}": forkFrom ${resolution.message} Nothing was created.`,
  };
};

/**
 * Node-label + house-style suffix for a scaffold rejection whose text came from
 * `validateSpawnGraph` (which speaks the spawn dialect, "Nothing was spawned.").
 * Scaffold rejections — including an implied-fork-edge cycle surfaced in Phase 2
 * — must read as node-labelled with the scaffold's "Nothing was created." suffix,
 * never leak a generic decider 500.
 */
export const scaffoldNodeRejectionMessage = (nodeKey: string, graphMessage: string): string =>
  `node "${nodeKey}": ${graphMessage.replace(/Nothing was spawned\.$/, "Nothing was created.")}`;

/** One scaffold node ready to hand to the `thread.scaffold` command factory. */
export interface ScaffoldGraphNode {
  readonly key: string;
  readonly threadId: ThreadId;
  /** Raw role (undefined for a fork node — identity is inherited). */
  readonly role: string | undefined;
  readonly title: string;
  readonly purpose: string;
  readonly blockedByRefs: ReadonlyArray<string>;
  readonly gateReworkRef: string | undefined;
  readonly gateMaxRounds: number | undefined;
  readonly isolationOverride: ThreadIsolation | undefined;
  readonly forkFromRef: string | undefined;
  /** NON-fork node: its handler-resolved selection. Undefined for fork nodes. */
  readonly baseSelection: ModelSelection | undefined;
}

export interface ScaffoldGraphResolvedNode {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly role: string | null;
  readonly title: string;
  readonly purpose: string;
  readonly blockedBy: ReadonlyArray<ThreadId> | undefined;
  readonly routes: ReadonlyArray<WorkstreamRoute> | undefined;
  readonly isolation: ThreadIsolation;
  readonly modelSelection: ModelSelection;
  readonly forkFromThreadId: ThreadId | undefined;
}

export type ScaffoldGraphResult =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly nodes: ReadonlyArray<ScaffoldGraphResolvedNode>;
      readonly warnings: ReadonlyArray<string>;
    };

interface ScaffoldExistingSibling {
  readonly id: ThreadId;
  readonly title: string | null;
  readonly role: string | null;
  readonly parentThreadId: ThreadId | null;
  readonly planLane: ThreadPlanLane;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  readonly session: unknown | null;
  readonly latestUserMessageAt: string | null;
  readonly graphKey: string | null;
  readonly modelSelection: ModelSelection;
}

/**
 * The whole two-phase scaffold graph assembly (D4) as ONE pure function, so the
 * handler↔phase wiring is regression-tested at the boundary the review requires
 * — not just the atomic helpers. It (1) resolves every reference (blockedBy /
 * gate.rework / forkFrom, archived-aware); (2) resolves fork-of-fork identity to
 * a fixed point in array-order-INDEPENDENT order; (3) MATERIALISES every implied
 * `blockedBy` edge into the effective graph; (4) validates the COMPLETE
 * effective graph per node — so an implied-edge-only cycle is a node-labelled
 * rejection HERE, never a dangling edge that reaches the decider as a caught
 * 500. Returns a node-labelled rejection or the per-node command inputs; the
 * handler only resolves model selections (impure) and dispatches.
 */
export const resolveScaffoldGraph = (input: {
  readonly parentThreadId: ThreadId;
  readonly nodes: ReadonlyArray<ScaffoldGraphNode>;
  readonly activeChildren: ReadonlyArray<ScaffoldExistingSibling>;
  readonly archivedChildren: ReadonlyArray<ScaffoldExistingSibling>;
  readonly instanceDrivers: ReadonlyMap<string, string>;
  readonly staged: boolean;
}): ScaffoldGraphResult => {
  const keyToId = new Map<string, ThreadId>();
  for (const node of input.nodes) keyToId.set(node.key, node.threadId);
  for (const child of input.activeChildren) {
    if (child.graphKey !== null && !keyToId.has(child.graphKey)) {
      keyToId.set(child.graphKey, child.id);
    }
  }
  const existingIds = new Set<ThreadId>(input.activeChildren.map((child) => child.id));

  interface Resolved {
    readonly node: ScaffoldGraphNode;
    readonly blockedByIds: ReadonlyArray<ThreadId>;
    readonly gateReworkId: ThreadId | undefined;
    readonly forkFromId: ThreadId | undefined;
  }
  // Phase 1: resolve every reference across the whole batch.
  const resolved: Resolved[] = [];
  for (const node of input.nodes) {
    const blockedByIds: ThreadId[] = [];
    for (const ref of node.blockedByRefs) {
      const r = resolveScaffoldReference({ ref, keyToId, existingIds });
      if (r.kind === "error") {
        return { kind: "error", message: `node "${node.key}": ${r.message} Nothing was created.` };
      }
      blockedByIds.push(r.id);
    }
    let gateReworkId: ThreadId | undefined;
    if (node.gateReworkRef !== undefined) {
      const r = resolveScaffoldReference({ ref: node.gateReworkRef, keyToId, existingIds });
      if (r.kind === "error") {
        return {
          kind: "error",
          message: `node "${node.key}": gate.rework ${r.message} Nothing was created.`,
        };
      }
      gateReworkId = r.id;
    }
    let forkFromId: ThreadId | undefined;
    if (node.forkFromRef !== undefined) {
      const r = resolveScaffoldForkReference({
        ref: node.forkFromRef,
        nodeKey: node.key,
        keyToId,
        existingIds,
        archived: input.archivedChildren,
      });
      if (r.kind === "error") return { kind: "error", message: r.message };
      forkFromId = r.id;
    }
    resolved.push({ node, blockedByIds, gateReworkId, forkFromId });
  }

  // Base identities a fork may inherit: existing children + NON-fork batch nodes.
  const baseIdentityById = new Map<ThreadId, ForkIdentity>();
  for (const child of input.activeChildren) {
    baseIdentityById.set(child.id, { role: child.role, modelSelection: child.modelSelection });
  }
  for (const r of resolved) {
    if (r.forkFromId !== undefined) continue;
    if (r.node.baseSelection === undefined) {
      return {
        kind: "error",
        message: `node "${r.node.key}": model selection could not be resolved. Nothing was created.`,
      };
    }
    baseIdentityById.set(r.node.threadId, {
      role: r.node.role ?? null,
      modelSelection: r.node.baseSelection,
    });
  }

  // Fork-of-fork inheritance to a fixed point (array-order-independent).
  const forkChains = resolveForkChains({
    nodes: resolved.map((r) => ({
      key: r.node.key,
      id: r.node.threadId,
      forkFromId: r.forkFromId,
    })),
    baseIdentityById,
    instanceDrivers: input.instanceDrivers,
  });
  if (forkChains.kind === "error") return { kind: "error", message: forkChains.message };

  const identityByKey = new Map<string, ForkIdentity>();
  for (const r of resolved) {
    if (r.forkFromId === undefined) {
      const base = baseIdentityById.get(r.node.threadId);
      if (base === undefined) {
        return {
          kind: "error",
          message: `node "${r.node.key}": model selection could not be resolved. Nothing was created.`,
        };
      }
      identityByKey.set(r.node.key, base);
      continue;
    }
    const identity = forkChains.identityByKey.get(r.node.key);
    if (identity === undefined) {
      return {
        kind: "error",
        message: `node "${r.node.key}": forkFrom source could not be resolved. Nothing was created.`,
      };
    }
    identityByKey.set(r.node.key, identity);
  }

  // Materialise every implied fork edge into the effective blockedBy — this is
  // what makes an implied-edge cycle visible to Phase 2's whole-graph check.
  const effectiveBlockedByByKey = new Map<string, ReadonlyArray<ThreadId>>();
  for (const r of resolved) {
    const effective =
      r.forkFromId !== undefined && !r.blockedByIds.includes(r.forkFromId)
        ? [...r.blockedByIds, r.forkFromId]
        : r.blockedByIds;
    effectiveBlockedByByKey.set(r.node.key, effective);
  }

  const batchSiblings: DependencySibling[] = resolved.map((r) => ({
    id: r.node.threadId,
    title: r.node.title,
    role: identityByKey.get(r.node.key)?.role ?? null,
    parentThreadId: input.parentThreadId,
    planLane: input.staged ? "planned" : "ready",
    blockedBy: effectiveBlockedByByKey.get(r.node.key) ?? r.blockedByIds,
    session: null,
    latestUserMessageAt: null,
  }));

  // Phase 2: validate the COMPLETE effective graph per node and assemble output.
  const warnings: string[] = [];
  const outNodes: ScaffoldGraphResolvedNode[] = [];
  for (const r of resolved) {
    const identity = identityByKey.get(r.node.key);
    if (identity === undefined) {
      return {
        kind: "error",
        message: `node "${r.node.key}": identity could not be resolved. Nothing was created.`,
      };
    }
    const effectiveRole = identity.role;
    const graph = validateSpawnGraph({
      siblings: [
        ...input.activeChildren,
        ...batchSiblings.filter((sibling) => sibling.id !== r.node.threadId),
      ],
      archivedSiblings: input.archivedChildren,
      blockedBy: r.blockedByIds.length > 0 ? r.blockedByIds : undefined,
      gateRework: r.gateReworkId,
      gateMaxRounds: r.node.gateMaxRounds,
      forkFrom: r.forkFromId,
      isolationOverride: r.node.isolationOverride,
      role: effectiveRole ?? "thread",
      newThreadId: r.node.threadId,
    });
    if (graph.kind === "rejected") {
      return { kind: "error", message: scaffoldNodeRejectionMessage(r.node.key, graph.message) };
    }
    for (const warning of graph.warnings) warnings.push(`[${r.node.key}] ${warning}`);

    const routes: ReadonlyArray<WorkstreamRoute> | undefined =
      r.gateReworkId === undefined
        ? undefined
        : [
            {
              on: ["needs_rework"],
              kind: "loop",
              to: r.gateReworkId,
              maxRounds: r.node.gateMaxRounds ?? DEFAULT_GATE_MAX_ROUNDS,
            },
            { on: ["clean", "fixed_inline"], kind: "resolve" },
          ];
    const isolation: ThreadIsolation = graph.forceAttached
      ? "attached"
      : (r.node.isolationOverride ?? roleDefaultIsolation(effectiveRole));

    outNodes.push({
      key: r.node.key,
      threadId: r.node.threadId,
      role: effectiveRole,
      title: r.node.title,
      purpose: r.node.purpose,
      blockedBy: graph.blockedBy,
      routes,
      isolation,
      modelSelection: identity.modelSelection,
      forkFromThreadId: r.forkFromId,
    });
  }
  return { kind: "ok", nodes: outNodes, warnings };
};

const unknownPresetMessage = (name: string, available: ReadonlyArray<string>): string =>
  `Unknown modelPreset "${name}". Available presets: ${
    available.length > 0 ? available.join(", ") : "none configured"
  }.`;

/**
 * One usable provider instance and the model slugs it advertises. An empty
 * `models` list means the instance is configured but its model catalogue has
 * not been snapshotted yet — the model slug is then validated best-effort
 * (skipped) rather than falsely rejected.
 */
export interface ModelCatalogueEntry {
  readonly instanceId: string;
  readonly models: ReadonlyArray<string>;
}

/**
 * The discoverable catalogue: every configured, available provider instance and
 * its known model slugs. Mirrors the launch-time validity set (an unavailable
 * shadow instance would fail `getInstanceInfo` at turn start) so a selection
 * that passes here is one the child can actually launch with.
 */
export const modelCatalogueOf = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ModelCatalogueEntry> =>
  providers.filter(isProviderAvailable).map((provider) => ({
    instanceId: provider.instanceId,
    models: provider.models.map((model) => model.slug),
  }));

export type ModelSelectionValidation =
  | { readonly kind: "ok" }
  | { readonly kind: "unknown-instance"; readonly instanceId: string }
  | {
      readonly kind: "unknown-model";
      readonly instanceId: string;
      readonly model: string;
      readonly models: ReadonlyArray<string>;
    };

/**
 * Fail-fast validation of an explicit `modelSelection` against the configured
 * catalogue: the instance must exist; the model slug is checked only when the
 * instance advertises a non-empty catalogue (best-effort — never reject a slug
 * against an unpopulated list).
 */
export const validateModelSelection = (
  selection: ModelSelection,
  catalogue: ReadonlyArray<ModelCatalogueEntry>,
): ModelSelectionValidation => {
  const entry = catalogue.find((e) => e.instanceId === selection.instanceId);
  if (entry === undefined) return { kind: "unknown-instance", instanceId: selection.instanceId };
  if (entry.models.length > 0 && !entry.models.includes(selection.model)) {
    return {
      kind: "unknown-model",
      instanceId: selection.instanceId,
      model: selection.model,
      models: entry.models,
    };
  }
  return { kind: "ok" };
};

const formatCatalogue = (catalogue: ReadonlyArray<ModelCatalogueEntry>): string =>
  catalogue.length === 0
    ? "none configured"
    : catalogue
        .map(
          (e) =>
            `${e.instanceId} (models: ${e.models.length > 0 ? e.models.join(", ") : "unknown"})`,
        )
        .join("; ");

const describeSource = (source: SelectionSource): string => {
  switch (source.kind) {
    case "explicit":
      return "This modelSelection";
    case "preset":
      return `modelPreset "${source.name}" (resolved from server settings)`;
    case "role-preset":
      return `The role-default preset for role "${source.role}" (resolved from server settings)`;
    case "task-shape":
      return `The taskShape "${source.shape}" resolution (resolved from server settings profiles)`;
    case "inherited":
      return "The inherited (parent) model selection";
  }
};

/**
 * Actionable 400 body for an invalid resolved `modelSelection`, whatever its
 * source (explicit selection, a stale configured preset, or a role default).
 */
export const invalidModelSelectionMessage = (
  validation: Exclude<ModelSelectionValidation, { readonly kind: "ok" }>,
  catalogue: ReadonlyArray<ModelCatalogueEntry>,
  presets: ReadonlyArray<string>,
  source: SelectionSource,
): string =>
  validation.kind === "unknown-instance"
    ? `${describeSource(source)} references instanceId "${validation.instanceId}", which is not a configured provider instance in this build. Valid instances: ${formatCatalogue(catalogue)}. Configured presets: ${presets.length > 0 ? presets.join(", ") : "none"}. Prefer a configured modelPreset (or omit both to inherit) rather than guessing instance ids/model slugs from another environment${source.kind === "preset" || source.kind === "role-preset" ? ", or fix the preset in server settings" : ""}. Nothing was spawned.`
    : `${describeSource(source)} references model "${validation.model}", which is not a known model for instance "${validation.instanceId}". Known models for ${validation.instanceId}: ${validation.models.join(", ")}. Nothing was spawned.`;

/**
 * A configured preset resolved against the catalogue for the discovery surface:
 * `valid` is false when the preset points at an instance/model that would be
 * rejected at spawn — so `workstream_list` never silently recommends a preset
 * that still strands the child.
 */
export interface PresetCatalogueEntry {
  readonly name: string;
  readonly instanceId: string;
  readonly model: string;
  readonly valid: boolean;
}

export const presetCatalogueOf = (
  presets: Record<string, ModelSelection>,
  catalogue: ReadonlyArray<ModelCatalogueEntry>,
): ReadonlyArray<PresetCatalogueEntry> =>
  Object.entries(presets).map(([name, selection]) => ({
    name,
    instanceId: selection.instanceId,
    model: selection.model,
    valid: validateModelSelection(selection, catalogue).kind === "ok",
  }));

/**
 * A compact capability-profile summary for the discovery surface (plan §6.5): a
 * parent sees the profile NAME, its `agentic` flag, honest `usableContext`, and
 * validity — enough to notice when a shape would pick an insufficient-context
 * model and deliberately override. `spawnable` is false for oracle profiles
 * (consultation-only). Scores/prices/usage stay server-side (the design's
 * information boundary).
 */
export interface ProfileSummaryEntry {
  readonly name: string;
  readonly agentic: WorkstreamModelProfile["agentic"];
  readonly usableContext?: number;
  readonly valid: boolean;
  readonly spawnable: boolean;
}

export const profileSummaryOf = (
  profiles: Record<string, WorkstreamModelProfile>,
  catalogue: ReadonlyArray<ModelCatalogueEntry>,
): ReadonlyArray<ProfileSummaryEntry> =>
  Object.entries(profiles).map(([name, profile]) => ({
    name,
    agentic: profile.agentic,
    ...(profile.usableContext !== undefined ? { usableContext: profile.usableContext } : {}),
    valid: validateModelSelection(profile.selection, catalogue).kind === "ok",
    spawnable: profile.agentic !== "oracle",
  }));

/**
 * The caller's whole workstream graph, active + archived. Both `list` (the
 * discovery view) and the same-tree auth predicate read this single set, so
 * "what you can see" and "what you can touch" are exactly the same scope.
 * Archived/finished threads are included — they are the likely inspection
 * targets.
 */
const collectGraphThreads = Effect.fn("WorkstreamHttp.collectGraphThreads")(function* () {
  const projection = yield* ProjectionSnapshotQuery;
  const active = yield* projection.getShellSnapshot();
  const archived = yield* projection.getArchivedShellSnapshot();
  return [...active.threads, ...archived.threads];
});

const handleWorkstreamSpawn = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamSpawnRequest => ({})),
  )) as WorkstreamSpawnRequest;
  const role = trimString(body.role);
  const purpose = trimString(body.purpose);
  const brief = trimString(body.brief);
  const title = trimString(body.title);
  // loom: forkFrom — the source thread to fork this child's pi session from.
  const forkFrom = trimString(body.forkFrom);
  // Default `ready` (runs once deps clear — current ergonomics); `staged: true`
  // creates a held `planned` node for the review-the-graph flow (design §3).
  const planLane: ThreadPlanLane = body.staged === true ? "planned" : "ready";
  // loom: forkFrom (D2) — a fork inherits the source's role (and model), so role
  // is NOT required (and is rejected below if supplied); a non-fork spawn still
  // requires it.
  if (!role && forkFrom === undefined) return jsonError(400, "role is required.");
  if (!purpose) return jsonError(400, "purpose is required.");
  if (!title) return jsonError(400, "title is required.");
  // loom: forkFrom (D2/D4) — identity fields and gate are rejected, never
  // silently ignored: the fork's identity comes from the source's launch record
  // and gate + forkFrom has no v1 composition.
  if (forkFrom !== undefined) {
    const identityRejection = forkIdentityFieldsRejection({
      // Presence from the RAW field, not the trimmed value: `role: ""` is a
      // PROVIDED identity field and must be rejected (D2 — never silently
      // ignored), even though trimString would collapse it to undefined.
      role: body.role !== undefined,
      modelSelection: body.modelSelection !== undefined,
      modelPreset: body.modelPreset !== undefined,
      taskShape: body.taskShape !== undefined,
      sensitive: body.sensitive !== undefined,
    });
    if (identityRejection !== undefined) return jsonError(400, identityRejection);
    if (body.gate !== undefined) return jsonError(400, forkFromGateConflictMessage());
  }
  if (
    body.blockedBy !== undefined &&
    (!Array.isArray(body.blockedBy) || !body.blockedBy.every((id) => trimString(id)))
  ) {
    return jsonError(400, "blockedBy must be an array of non-empty thread id strings.");
  }
  // Review gates (design §4.2): the v1 gate sugar. Shape-validate here; the
  // sibling rule is checked against the projection below.
  const gate =
    typeof body.gate === "object" && body.gate !== null && !Array.isArray(body.gate)
      ? (body.gate as { readonly rework?: unknown; readonly maxRounds?: unknown })
      : undefined;
  const gateRework = gate === undefined ? undefined : trimString(gate.rework);
  const isolationOverride = trimString(body.isolation);
  if (
    isolationOverride !== undefined &&
    !VALID_SPAWN_ISOLATIONS.has(isolationOverride as ThreadIsolation)
  ) {
    return jsonError(400, `isolation must be one of: ${SPAWN_ISOLATIONS.join(", ")}.`);
  }
  if (body.gate !== undefined) {
    if (gate === undefined || !gateRework) {
      return jsonError(400, "gate must be an object with a non-empty rework thread id.");
    }
    if (
      gate.maxRounds !== undefined &&
      (typeof gate.maxRounds !== "number" ||
        !Number.isInteger(gate.maxRounds) ||
        gate.maxRounds < 1 ||
        gate.maxRounds > MAX_GATE_MAX_ROUNDS)
    ) {
      return jsonError(
        400,
        `gate.maxRounds must be an integer between 1 and ${MAX_GATE_MAX_ROUNDS}. Each round is a full rework + re-review cycle; if you expect to need more than a few, the work should be re-scoped instead of looped.`,
      );
    }
  }

  const projection = yield* ProjectionSnapshotQuery;
  const parent = yield* projection.getThreadDetailById(scope.threadId);
  if (Option.isNone(parent)) {
    return jsonError(404, "Current provider thread was not found.");
  }
  const current = parent.value;

  const activeSnapshot = yield* projection.getShellSnapshot();
  const activeChildren = activeSnapshot.threads.filter(
    (thread) => thread.parentThreadId === scope.threadId,
  );
  const archivedSnapshot = yield* projection.getArchivedShellSnapshot();
  const archivedChildren = archivedSnapshot.threads.filter(
    (thread) => thread.parentThreadId === scope.threadId,
  );

  // Model + thinking are intrinsic node config. Precedence (resolved by the pure
  // resolveSpawnModelSelection below):
  //   1. explicit `modelSelection` (decoded; invalid → 400),
  //   2. named `modelPreset` (unknown → 400),
  //   3. `taskShape` → capability-profile resolution (§3–§4),
  //   4. a preset keyed by the child's `role`,
  //   5. inherit the parent's selection.
  // Fail-fast validation front-runs the launch-time "unknown provider instance"
  // error that would otherwise strand the child. The catalogue is seeded with
  // every configured instance at registry build, so instance-id validation is
  // reliable from boot; model slugs are checked best-effort (only against a
  // populated per-instance catalogue).
  const providers = yield* (yield* ProviderRegistry).getProviders;
  // loom: forkFrom (D4) — pi-backed check reads provider instance metadata, not
  // session.providerName (an unlaunched in-batch source has no session).
  const instanceDrivers = instanceDriverKinds(providers);

  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const childThreadId = ThreadId.make(yield* crypto.randomUUIDv4);

  // loom: forkFrom (D2) — a fork's role + applied model selection are inherited
  // from the resolved source; a non-fork spawn resolves them from the precedence
  // ladder below. `storedRole` is what lands on the child's thread record.
  let modelSelection: ModelSelection;
  let storedRole: string | null = role ?? null;
  let forkFromId: ThreadId | undefined;
  const selectionWarnings: string[] = [];
  const exhaustionWarnings: string[] = [];

  if (forkFrom !== undefined) {
    const source = resolveForkSource({
      forkFrom: ThreadId.make(forkFrom),
      newChildId: childThreadId,
      activeChildren,
      archivedChildren,
      instanceDrivers,
    });
    if (source.kind === "rejected") return jsonError(400, source.message);
    forkFromId = source.id;
    storedRole = source.identity.role;
    modelSelection = source.identity.modelSelection;
  } else {
    const catalogue = modelCatalogueOf(providers);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    const presetNames = Object.keys(settings.workstreamModelPresets);
    const usageSourceSet = usageSourceInstances(settings.providerInstances);
    // Live headroom facts shared by shape resolution and the exhaustion warning:
    // the raw usage windows (for the ≥90% demotion) and the hard-exhaustion
    // predicate (for skipping / the warning). Read once. Stale/missing data
    // resolves to healthy inside the resolver.
    const health = yield* ProviderHealthRegistry;
    const isExhausted = exhaustionPredicate(yield* health.snapshot);
    const headroom: ShapeHeadroomInput = {
      usage: yield* (yield* AccountUsageRegistry).snapshot,
      isExhausted,
      usageSourceInstances: usageSourceSet,
      nowMs: yield* Clock.currentTimeMillis,
    };

    // Precedence (plan §3): explicit modelSelection > modelPreset > taskShape >
    // role preset > inherit — decoded/validated as ONE pure function so the whole
    // decision is testable (§6.7). The handler only performs the async
    // modelSelection decode and hands the result in.
    const explicitDecoded =
      body.modelSelection === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* decodeModelSelection(body.modelSelection).pipe(
              Effect.map(Option.some),
              Effect.orElseSucceed(() => Option.none<ModelSelection>()),
            ),
          );
    const resolution = resolveSpawnModelSelection({
      explicit: { provided: body.modelSelection !== undefined, decoded: explicitDecoded },
      modelPreset: body.modelPreset,
      taskShape: body.taskShape,
      sensitive: body.sensitive,
      presets: settings.workstreamModelPresets as Record<string, ModelSelection>,
      profiles: settings.workstreamModelProfiles as Record<string, WorkstreamModelProfile>,
      catalogue,
      presetNames,
      // In this branch forkFrom is unset, so the role-required guard above
      // guarantees a role; `?? "thread"` only satisfies the type narrowing.
      role: role ?? "thread",
      parentSelection: current.modelSelection,
      headroom,
    });
    if (resolution.kind === "error") return jsonError(400, resolution.message);
    modelSelection = resolution.selection;
    for (const warning of resolution.warnings) selectionWarnings.push(warning);

    // Exhaustion-aware spawn warning (§7): consult the health registry for the
    // resolved selection (all precedence steps, explicit included). No selection
    // rewriting (D6) — warn only. Reuses the `isExhausted` predicate read above.
    const slugScope = subscriptionScopeForSelection(modelSelection, usageSourceSet);
    if (slugScope.accountKey !== null) {
      if (isExhausted(slugScope.accountKey, slugScope.modelId)) {
        const until = yield* health.exhaustedUntil(slugScope.accountKey, slugScope.modelId);
        // Non-fatal: a settings read failure must not 500 a spawn that would
        // otherwise succeed; default to the schema default (failover enabled).
        const failover = yield* (yield* ServerSettingsService).getSettings.pipe(
          Effect.map((s) => ({
            enabled: s.providerFailover.enabled,
            chains: s.providerFailover.chains,
          })),
          Effect.orElseSucceed(() => ({ enabled: true, chains: undefined })),
        );
        // Name the concrete fallback when one is healthy (§7). Only a pi selection
        // with failover on reroutes (§9); direct drivers always warn wait-to-reset.
        const fallbackTarget =
          failover.enabled && slugScope.isPiSubscriptionSlug
            ? resolveFailoverTarget({
                slug: modelSelection.model,
                catalogue: piCatalogueFromProviders(providers),
                isExhausted,
                ...(failover.chains !== undefined ? { chains: failover.chains } : {}),
              })
            : undefined;
        exhaustionWarnings.push(
          buildSpawnExhaustionWarning({
            slug: modelSelection.model,
            resetHint: formatResetHint(until, yield* Clock.currentTimeMillis),
            fallbackTarget,
          }),
        );
      }
    }
  }

  // Trim before branding: ThreadId.make("") throws a defect that escapes the
  // typed Effect.catch, and untrimmed ids silently become dangling deps.
  const blockedBy = Array.isArray(body.blockedBy)
    ? body.blockedBy.map((id) => ThreadId.make((id as string).trim()))
    : undefined;

  const graph = validateSpawnGraph({
    siblings: activeChildren,
    archivedSiblings: archivedChildren,
    blockedBy,
    gateRework: gateRework === undefined ? undefined : ThreadId.make(gateRework),
    gateMaxRounds: gate?.maxRounds as number | undefined,
    forkFrom: forkFromId,
    isolationOverride: isolationOverride as ThreadIsolation | undefined,
    role: storedRole ?? "thread",
    newThreadId: childThreadId,
  });
  if (graph.kind === "rejected") return jsonError(400, graph.message);

  const routes: ReadonlyArray<WorkstreamRoute> | undefined =
    gateRework === undefined
      ? undefined
      : [
          {
            on: ["needs_rework"],
            kind: "loop",
            to: ThreadId.make(gateRework),
            maxRounds: (gate?.maxRounds as number | undefined) ?? DEFAULT_GATE_MAX_ROUNDS,
          },
          { on: ["clean", "fixed_inline"], kind: "resolve" },
        ];

  // Generation = the parent's ACTIVE turn at spawn time, so siblings spawned in
  // the same parent turn join into one wake. When the parent is not mid-turn
  // (no active turn) the spawn is out-of-turn and gets its own singleton
  // generation (the child id) — never the parent's last *completed* turn, which
  // would merge an out-of-turn spawn into a stale, already-joined generation.
  const spawnGeneration = current.session?.activeTurnId ?? childThreadId;

  // Worktree isolation (design §1): a gated reviewer is forced `attached` (it
  // joins its gate target's worktree at promotion, §4); everything else honours
  // the explicit override or takes the role default.
  const isolation: ThreadIsolation = graph.forceAttached
    ? "attached"
    : ((isolationOverride as ThreadIsolation | undefined) ?? roleDefaultIsolation(storedRole));

  // Create-only: the WorkstreamDispatcher is the sole start authority and fires
  // the deferred kick-off turn once every `blockedBy` thread reaches `done`.
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(
      `server:workstream-spawn:create-thread:${yield* crypto.randomUUIDv4}`,
    ),
    threadId: childThreadId,
    projectId: current.projectId,
    goalId: current.goalId ?? null,
    parentThreadId: scope.threadId,
    // loom: forkFrom (D2) — the stored role is the source's role for a fork.
    role: storedRole,
    purpose,
    ...(brief !== undefined ? { brief } : {}),
    ...(graph.blockedBy !== undefined ? { blockedBy: graph.blockedBy } : {}),
    ...(routes !== undefined ? { routes } : {}),
    // loom: forkFrom — the driver forks the source's pi session at first launch.
    ...(forkFromId !== undefined ? { forkFromThreadId: forkFromId } : {}),
    isolation,
    planLane,
    spawnGeneration,
    title,
    titleProvenance: "curated", // loom: §4 the spawn title is a curated label
    modelSelection,
    runtimeMode: current.runtimeMode,
    interactionMode: current.interactionMode,
    branch: current.branch,
    worktreePath: current.worktreePath,
    createdAt: now,
  } satisfies OrchestrationCommand);

  // Scaffold-first dual-period rule (plan §1a): the dispatcher's brief gate now
  // launches a child only once `kickoffBriefPath` is set, so a spawn must write
  // its EFFECTIVE kickoff (`brief ?? purpose`, matching the historical
  // promoteThread fallback) through to a brief file at spawn time — giving the
  // dispatcher one read path and keeping legacy brief-less spawns launchable.
  const kickoffBriefPath = yield* writeWorkstreamBrief(childThreadId, brief ?? purpose);
  yield* engine.dispatch({
    type: "thread.kickoff-brief.set",
    commandId: CommandId.make(`server:workstream-spawn:set-brief:${yield* crypto.randomUUIDv4}`),
    threadId: childThreadId,
    kickoffBriefPath,
    createdAt: now,
  } satisfies OrchestrationCommand);

  const warnings = [...graph.warnings, ...selectionWarnings, ...exhaustionWarnings];
  return HttpServerResponse.jsonUnsafe({
    childThreadId,
    parentThreadId: scope.threadId,
    title,
    ...(warnings.length > 0 ? { warnings } : {}),
    rendered: appendWarnings(`Spawned Workstream sub-thread ${childThreadId}: ${title}`, warnings),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(
        500,
        error instanceof Error ? error.message : "Failed to spawn Workstream sub-thread.",
      ),
    ),
  ),
);

// Scaffold-first graph authoring (workstream-scaffold plan). One call lays out
// the whole child topology (or a delta) with cheap metadata only — no briefs.
// Threads are created eagerly (real ids, visible immediately) but cannot launch
// until each gets a brief (workstream_brief). The handler does schema/shape
// checks, symbolic-key resolution, per-node model + warning resolution; the
// decider owns the transactional all-or-nothing graph validation (unique keys,
// no cycles, no dangling refs) and emits every thread.created in ONE engine
// transaction.
const handleWorkstreamScaffold = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamScaffoldRequest => ({})),
  )) as WorkstreamScaffoldRequest;
  if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
    return jsonError(400, "nodes must be a non-empty array of scaffold node objects.");
  }
  const staged = body.staged === true;

  // Shape-parse + preallocate a thread id per node up front. Any shape error
  // creates nothing and names the offending key.
  const crypto = yield* Crypto.Crypto;
  interface ParsedNode {
    readonly key: string;
    readonly threadId: ThreadId;
    readonly role: string | undefined;
    readonly purpose: string;
    readonly title: string;
    readonly raw: WorkstreamScaffoldNodeRequest;
    readonly gateRework: string | undefined;
    readonly gateMaxRounds: number | undefined;
    readonly isolationOverride: string | undefined;
    // loom: forkFrom — raw reference (key | thread:id), resolved in phase 1.
    readonly forkFromRef: string | undefined;
  }
  const parsed: ParsedNode[] = [];
  const seenKeys = new Set<string>();
  for (const rawNode of body.nodes as ReadonlyArray<unknown>) {
    const node =
      typeof rawNode === "object" && rawNode !== null && !Array.isArray(rawNode)
        ? (rawNode as WorkstreamScaffoldNodeRequest)
        : ({} as WorkstreamScaffoldNodeRequest);
    const key = trimString(node.key);
    if (!key) return jsonError(400, "each node requires a non-empty key.");
    if (UUID_SHAPED.test(key)) {
      return jsonError(
        400,
        `node key "${key}" is UUID-shaped; keys must be symbolic (reference an existing thread with the "thread:" prefix instead).`,
      );
    }
    if (seenKeys.has(key)) {
      return jsonError(
        400,
        `node key "${key}" is duplicated within the scaffold; keys are unique per parent.`,
      );
    }
    seenKeys.add(key);
    const role = trimString(node.role);
    const purpose = trimString(node.purpose);
    const title = trimString(node.title);
    // loom: forkFrom (D2) — a fork node inherits role + model from its source, so
    // role is NOT required (and identity/model fields + gate are rejected below).
    const forkFromRef = trimString(node.forkFrom);
    if (!role && forkFromRef === undefined)
      return jsonError(400, `node "${key}": role is required.`);
    if (!purpose) return jsonError(400, `node "${key}": purpose is required.`);
    if (!title) return jsonError(400, `node "${key}": title is required.`);
    if (forkFromRef !== undefined) {
      const identityRejection = forkIdentityFieldsRejection(
        {
          // Raw presence (D2): a provided `role`, even empty, is rejected.
          role: node.role !== undefined,
          modelSelection: node.modelSelection !== undefined,
          modelPreset: node.modelPreset !== undefined,
          taskShape: node.taskShape !== undefined,
          sensitive: node.sensitive !== undefined,
        },
        "Nothing was created.",
      );
      if (identityRejection !== undefined) {
        return jsonError(400, `node "${key}": ${identityRejection}`);
      }
      if (node.gate !== undefined) {
        return jsonError(
          400,
          `node "${key}": ${forkFromGateConflictMessage("Nothing was created.")}`,
        );
      }
    }
    if (
      node.blockedBy !== undefined &&
      (!Array.isArray(node.blockedBy) || !node.blockedBy.every((r) => trimString(r)))
    ) {
      return jsonError(
        400,
        `node "${key}": blockedBy must be an array of non-empty reference strings.`,
      );
    }
    const gate =
      typeof node.gate === "object" && node.gate !== null && !Array.isArray(node.gate)
        ? (node.gate as { readonly rework?: unknown; readonly maxRounds?: unknown })
        : undefined;
    const gateRework = gate === undefined ? undefined : trimString(gate.rework);
    if (node.gate !== undefined && (gate === undefined || !gateRework)) {
      return jsonError(
        400,
        `node "${key}": gate must be an object with a non-empty rework reference.`,
      );
    }
    if (
      gate?.maxRounds !== undefined &&
      (typeof gate.maxRounds !== "number" ||
        !Number.isInteger(gate.maxRounds) ||
        gate.maxRounds < 1 ||
        gate.maxRounds > MAX_GATE_MAX_ROUNDS)
    ) {
      return jsonError(
        400,
        `node "${key}": gate.maxRounds must be an integer between 1 and ${MAX_GATE_MAX_ROUNDS}.`,
      );
    }
    const isolationOverride = trimString(node.isolation);
    if (
      isolationOverride !== undefined &&
      !VALID_SPAWN_ISOLATIONS.has(isolationOverride as ThreadIsolation)
    ) {
      return jsonError(
        400,
        `node "${key}": isolation must be one of: ${SPAWN_ISOLATIONS.join(", ")}.`,
      );
    }
    parsed.push({
      key,
      threadId: ThreadId.make(yield* crypto.randomUUIDv4),
      role,
      purpose,
      title,
      raw: node,
      gateRework,
      gateMaxRounds: gate?.maxRounds as number | undefined,
      isolationOverride,
      forkFromRef,
    });
  }

  const projection = yield* ProjectionSnapshotQuery;
  const parentDetail = yield* projection.getThreadDetailById(scope.threadId);
  if (Option.isNone(parentDetail)) {
    return jsonError(404, "Current provider thread was not found.");
  }
  const current = parentDetail.value;

  const activeSnapshot = yield* projection.getShellSnapshot();
  const activeChildren = activeSnapshot.threads.filter(
    (thread) => thread.parentThreadId === scope.threadId,
  );
  const archivedSnapshot = yield* projection.getArchivedShellSnapshot();
  const archivedChildren = archivedSnapshot.threads.filter(
    (thread) => thread.parentThreadId === scope.threadId,
  );

  // loom: forkFrom (D4) — pi-backed check reads provider instance metadata (an
  // unlaunched in-batch source has no session). Read providers/settings ONCE.
  const providers = yield* (yield* ProviderRegistry).getProviders;
  const instanceDrivers = instanceDriverKinds(providers);
  const catalogue = modelCatalogueOf(providers);
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const presetNames = Object.keys(settings.workstreamModelPresets);
  const usageSourceSet = usageSourceInstances(settings.providerInstances);
  const health = yield* ProviderHealthRegistry;
  const isExhausted = exhaustionPredicate(yield* health.snapshot);
  const headroom: ShapeHeadroomInput = {
    usage: yield* (yield* AccountUsageRegistry).snapshot,
    isExhausted,
    usageSourceInstances: usageSourceSet,
    nowMs: yield* Clock.currentTimeMillis,
  };

  // Resolve each NON-fork node's model selection (impure: needs settings +
  // headroom + catalogue). Fork nodes inherit their source's identity inside
  // resolveScaffoldGraph and are skipped here.
  const modelWarnings: string[] = [];
  const baseSelectionByKey = new Map<string, ModelSelection>();
  for (const node of parsed) {
    if (node.forkFromRef !== undefined) continue;
    const explicitDecoded =
      node.raw.modelSelection === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* decodeModelSelection(node.raw.modelSelection).pipe(
              Effect.map(Option.some),
              Effect.orElseSucceed(() => Option.none<ModelSelection>()),
            ),
          );
    const resolution = resolveSpawnModelSelection({
      explicit: { provided: node.raw.modelSelection !== undefined, decoded: explicitDecoded },
      modelPreset: node.raw.modelPreset,
      taskShape: node.raw.taskShape,
      sensitive: node.raw.sensitive,
      presets: settings.workstreamModelPresets as Record<string, ModelSelection>,
      profiles: settings.workstreamModelProfiles as Record<string, WorkstreamModelProfile>,
      catalogue,
      presetNames,
      role: node.role ?? "thread",
      parentSelection: current.modelSelection,
      headroom,
    });
    if (resolution.kind === "error")
      return jsonError(400, `node "${node.key}": ${resolution.message}`);
    for (const warning of resolution.warnings) modelWarnings.push(`[${node.key}] ${warning}`);
    baseSelectionByKey.set(node.key, resolution.selection);
  }

  // The whole two-phase graph assembly (D4) in one pure, boundary-tested call:
  // reference resolution + fork-of-fork inheritance + implied-edge
  // materialisation + complete-graph validation. A node-labelled rejection here
  // is a 400 BEFORE any dispatch — an implied-edge cycle never reaches the
  // decider as a caught 500.
  const graphResult = resolveScaffoldGraph({
    parentThreadId: scope.threadId,
    nodes: parsed.map((node) => ({
      key: node.key,
      threadId: node.threadId,
      role: node.role,
      title: node.title,
      purpose: node.purpose,
      blockedByRefs: Array.isArray(node.raw.blockedBy)
        ? node.raw.blockedBy.map((r) => (r as string).trim())
        : [],
      gateReworkRef: node.gateRework,
      gateMaxRounds: node.gateMaxRounds,
      isolationOverride: node.isolationOverride as ThreadIsolation | undefined,
      forkFromRef: node.forkFromRef,
      baseSelection: baseSelectionByKey.get(node.key),
    })),
    activeChildren,
    archivedChildren,
    instanceDrivers,
    staged,
  });
  if (graphResult.kind === "error") return jsonError(400, graphResult.message);
  const warnings = [...modelWarnings, ...graphResult.warnings];

  // One spawn generation for the whole batch (the parent's active turn, or a
  // fresh singleton when authored out-of-turn) so the nodes join one wake.
  const spawnGeneration = current.session?.activeTurnId ?? (yield* crypto.randomUUIDv4);
  const commandNodes = graphResult.nodes.map((node) => ({
    threadId: node.threadId,
    graphKey: node.key,
    role: node.role,
    title: node.title,
    purpose: node.purpose,
    isolation: node.isolation,
    ...(node.blockedBy !== undefined ? { blockedBy: node.blockedBy } : {}),
    ...(node.routes !== undefined ? { routes: node.routes } : {}),
    ...(node.forkFromThreadId !== undefined ? { forkFromThreadId: node.forkFromThreadId } : {}),
    spawnGeneration,
    modelSelection: node.modelSelection,
  }));

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.scaffold",
    commandId: CommandId.make(`server:workstream-scaffold:${yield* crypto.randomUUIDv4}`),
    parentThreadId: scope.threadId,
    ...(staged ? { staged: true } : {}),
    nodes: commandNodes,
    createdAt: now,
  } satisfies OrchestrationCommand);

  const nodes = graphResult.nodes.map((node) => ({
    key: node.key,
    threadId: node.threadId,
    title: node.title,
  }));
  return HttpServerResponse.jsonUnsafe({
    parentThreadId: scope.threadId,
    nodes,
    ...(warnings.length > 0 ? { warnings } : {}),
    rendered: appendWarnings(
      `Scaffolded ${nodes.length} Workstream node(s): ${nodes
        .map((node) => `${node.key} → ${node.threadId}`)
        .join(", ")}. Each awaits a brief (workstream_brief) before it can launch.`,
      warnings,
    ),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(
        500,
        error instanceof Error ? error.message : "Failed to scaffold the Workstream graph.",
      ),
    ),
  ),
);

// Scaffold-first graph authoring: attach the kickoff brief to one scaffolded
// node just-in-time. Valid only on a direct child that has NOT started; writes
// the markdown atomically via the brief-storage module and event-sources the
// path onto `kickoffBriefPath`, which is the second launch precondition (deps
// satisfied AND brief present). Overwrite is allowed pre-launch.
const handleWorkstreamBrief = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamBriefRequest => ({})),
  )) as WorkstreamBriefRequest;
  const nodeRef = trimString(body.node);
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
  if (!nodeRef) return jsonError(400, "node is required (a direct child's key or thread id).");
  if (markdown === undefined || markdown.trim().length === 0) {
    return jsonError(400, "markdown is required.");
  }

  const projection = yield* ProjectionSnapshotQuery;
  const activeSnapshot = yield* projection.getShellSnapshot();
  const children = activeSnapshot.threads.filter(
    (thread) => thread.parentThreadId === scope.threadId,
  );
  const stripped = nodeRef.startsWith(SCAFFOLD_THREAD_REF_PREFIX)
    ? nodeRef.slice(SCAFFOLD_THREAD_REF_PREFIX.length).trim()
    : nodeRef;
  const target = children.find((child) => child.id === stripped || child.graphKey === stripped);
  if (target === undefined) {
    return jsonError(
      404,
      `No direct child matches "${nodeRef}". A brief may only be attached to a thread you directly parent (by key or thread id).`,
    );
  }
  if (hasThreadStarted(target)) {
    return jsonError(
      409,
      `Child ${target.id} has already started — its kickoff is fixed. Use workstream_prompt to steer it.`,
    );
  }

  const briefPath = yield* writeWorkstreamBrief(target.id, markdown);
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.kickoff-brief.set",
    commandId: CommandId.make(`server:workstream-brief:${yield* crypto.randomUUIDv4}`),
    threadId: target.id,
    kickoffBriefPath: briefPath,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    threadId: target.id,
    briefPath,
    rendered: `Attached kickoff brief to Workstream child ${target.id}${
      target.graphKey !== null ? ` (${target.graphKey})` : ""
    }. It launches once its dependencies are done.`,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to attach the brief."),
    ),
  ),
);

const handleWorkstreamSetLane = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamLaneRequest => ({})),
  )) as WorkstreamLaneRequest;
  const threadId = trimString(body.threadId);
  const planLane = trimString(body.planLane);
  if (!planLane || !VALID_LANES.has(planLane as ThreadPlanLane)) {
    return jsonError(400, `planLane must be one of: ${SETTABLE_LANES.join(", ")}.`);
  }

  // Missing threadId defaults to the caller's own thread (always authorised).
  const targetThreadId = threadId ? ThreadId.make(threadId) : scope.threadId;
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  // Bypass guard (review-gates design §5.3), keyed off the ACTOR SCOPE: a gate
  // party may not SELF-set `done` around the routing — with an open rework
  // round or an unresolved gate as source, completion must go through
  // workstream_submit so the outcome routes the gate. A parent-issued lane
  // change (targetThreadId !== scope.threadId) deliberately bypasses this
  // (decision 9: parent overrides dissolve gates).
  if (planLane === "done" && targetThreadId === scope.threadId) {
    const self = yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(targetThreadId);
    if (Option.isSome(self) && requiresSubmitToComplete(self.value)) {
      return jsonError(
        409,
        "This thread is part of an active review gate; finish with workstream_submit (your outcome routes the gate) instead of setting your own lane to done.",
      );
    }
  }

  // Gate observability (2026-07-07 incident): a parent force-`done` on a
  // rework TARGET mid-round stays legal (decision 9 interruptibility) but does
  // NOT resolve the gate — warn in the tool response so "accepting the coder"
  // is not mistaken for dissolving the review (that is a reviewer-side done).
  const warnings: string[] = [];
  if (planLane === "done" && targetThreadId !== scope.threadId) {
    const snapshot = yield* (yield* ProjectionSnapshotQuery).getShellSnapshot();
    const target = snapshot.threads.find((thread) => thread.id === targetThreadId);
    const source =
      target !== undefined && target.pendingRework && target.planLane !== "done"
        ? gateSourceFor(targetThreadId, snapshot.threads)
        : null;
    if (source !== null) {
      warnings.push(
        `this thread holds an open review-gate rework round — setting it done does NOT resolve the gate. Its next workstream_submit still routes to reviewer '${source.id}' for re-verification; to dissolve the gate, set the reviewer done/cancelled instead.`,
      );
    }
  }

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.plan-lane.set",
    commandId: CommandId.make(`server:workstream-lane:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    planLane: planLane as ThreadPlanLane,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    threadId: targetThreadId,
    planLane,
    // loom: warnings folded into the server-rendered text (the collapsed
    // provider-tool bridge prints only `result.rendered`), preserving main's
    // review-gate force-done observability warning.
    rendered: appendWarnings(
      `Set Workstream thread ${targetThreadId} plan lane to ${planLane}.`,
      warnings,
    ),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to set Workstream lane."),
    ),
  ),
);

const handleWorkstreamRequestAttention = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamAttentionRequest => ({})),
  )) as WorkstreamAttentionRequest;
  const threadId = trimString(body.threadId);
  const reason = trimString(body.reason);
  if (!reason || !VALID_REASONS.has(reason as AttentionReason)) {
    return jsonError(400, `reason must be one of: ${RAISABLE_REASONS.join(", ")}.`);
  }

  const targetThreadId = threadId ? ThreadId.make(threadId) : scope.threadId;
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.attention.raise",
    commandId: CommandId.make(`server:workstream-attention:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    reason: reason as AttentionReason,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    threadId: targetThreadId,
    reason,
    rendered: `Flagged Workstream thread ${targetThreadId} for attention: ${reason}.`,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to request attention."),
    ),
  ),
);

// Release a held subtree: flip every `planned` node in the target's subtree to
// `ready`. Reports the scope (which nodes flipped) so an intentional mixed-hold
// is not silently erased.
const handleWorkstreamRelease = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamTargetRequest => ({})),
  )) as WorkstreamTargetRequest;
  const threadId = trimString(body.threadId);
  const targetThreadId = threadId ? ThreadId.make(threadId) : scope.threadId;
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const threads = yield* collectGraphThreads();
  const held = subtreeOf(targetThreadId, threads).filter((t) => t.planLane === "planned");
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  for (const node of held) {
    yield* engine.dispatch({
      type: "thread.plan-lane.set",
      commandId: CommandId.make(`server:workstream-release:${yield* crypto.randomUUIDv4}`),
      threadId: node.id,
      planLane: "ready",
      createdAt: now,
    } satisfies OrchestrationCommand);
  }

  const released = held.map((node) => node.id);
  return HttpServerResponse.jsonUnsafe({
    threadId: targetThreadId,
    released,
    rendered:
      released.length > 0
        ? `Released ${released.length} held sub-thread(s): ${released.join(", ")}.`
        : "No held (planned) sub-threads to release in that subtree.",
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to release subtree."),
    ),
  ),
);

// Orchestrator stop of a direct child: interrupt the active turn WITHOUT raising
// attention (the `server:` commandId tells the decider this is an
// orchestrator-owned pause, not a human stop — the orchestrator owns the
// resume; the dispatcher's idle backstop covers a forgotten one).
const handleWorkstreamStop = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamTargetRequest => ({})),
  )) as WorkstreamTargetRequest;
  const threadId = trimString(body.threadId);
  if (!threadId) return jsonError(400, "threadId is required.");
  const targetThreadId = ThreadId.make(threadId);
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.turn.interrupt",
    commandId: CommandId.make(`server:workstream-stop:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    threadId: targetThreadId,
    rendered: `Stopped Workstream child ${targetThreadId} (paused, lane stays in_progress — resume it with workstream_prompt).`,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to stop the thread."),
    ),
  ),
);

// Orchestrator prompt to a direct child: dispatch a plain `thread.turn.start`
// carrying the parent's markdown message. On an idle child this starts/resumes
// a turn; on a child with an open turn PiDriver maps it to a queued steer
// folded in between model rounds (no `requireIdle`, no `setInProgress` — the
// same shape as the liveness nudge's steer).
const handleWorkstreamPrompt = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamPromptRequest => ({})),
  )) as WorkstreamPromptRequest;
  const threadId = trimString(body.threadId);
  const message =
    typeof body.message === "string" && body.message.trim().length > 0 ? body.message : undefined;
  if (!threadId) return jsonError(400, "threadId is required.");
  if (!message) return jsonError(400, "message is required.");
  const targetThreadId = ThreadId.make(threadId);
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const projection = yield* ProjectionSnapshotQuery;
  const target = yield* projection.getThreadDetailById(targetThreadId);
  if (Option.isNone(target)) return jsonError(404, "Target thread was not found.");
  // Sticky terminal (design §3.4/§6): the decider treats a turn-start on a
  // `done`/`cancelled` thread as a silent re-engagement — runtime runs, lane
  // and attention unchanged. Reject it here instead: a parent prompting a
  // terminal child is almost always a mistake, and a deliberate re-open goes
  // through workstream_set_lane (or a new spawn) first.
  if (target.value.planLane === "done" || target.value.planLane === "cancelled") {
    return jsonError(
      409,
      `Thread is ${target.value.planLane}; prompting would re-engage it without changing its lane. Re-open it with workstream_set_lane first, or spawn a new child.`,
    );
  }

  // Scaffold-first (plan §1) + forkFrom (D8): a prompt on a child whose kickoff
  // was never DELIVERED to pi (re)composes the kickoff; a child that has already
  // received its kickoff takes the plain steer/resume path below. The predicate
  // is the persisted kickoff-delivered marker, NOT session/message presence: a
  // backstop-refused fork or an exhausted first turn has a persisted user
  // message yet an absent marker and a brief that never reached the transcript.
  // An assistant message is an additional SOUND delivered-signal (pi only
  // produces output for a delivered prompt) that self-heals threads predating
  // the marker. Handler-level only — the plan rejects transactional first-turn
  // enforcement.
  const { workstreamLaunchIdentityDir } = yield* ServerConfig;
  const kickoffDelivered =
    isKickoffDelivered(workstreamLaunchIdentityDir, targetThreadId) ||
    target.value.messages.some((entry) => entry.role === "assistant");
  let kickoffText = message;
  if (!kickoffDelivered) {
    if (target.value.kickoffBriefPath === null) {
      return jsonError(
        409,
        `Child ${targetThreadId} has not been briefed yet — call workstream_brief to write its kickoff (it then launches once its dependencies clear). workstream_prompt steers an already-running child.`,
      );
    }
    const brief = Option.getOrUndefined(
      yield* readWorkstreamBriefAt(target.value.kickoffBriefPath),
    );
    if (brief === undefined) {
      return jsonError(
        409,
        `Child ${targetThreadId} has a brief pointer but its file could not be read; re-attach it with workstream_brief.`,
      );
    }
    // loom: forkFrom (D7) — an unstarted/undelivered fork child must not launch
    // while its source is mid-turn: `pi --fork` would copy an unclosed session.
    // This plain-prompt path bypasses the release/dependency gates, so without
    // this guard it would re-open the stranding hole the dispatcher gate closes.
    if (
      target.value.forkFromThreadId !== null &&
      resolveSessionFilePath(piSessionIdForThread(targetThreadId)) === undefined
    ) {
      const pendingTurnStartThreadIds = yield* projection.getPendingTurnStartThreadIds();
      const source = Option.getOrUndefined(
        yield* projection.getThreadDetailById(target.value.forkFromThreadId),
      );
      if (
        shouldRefuseForkLaunch({
          forkFromThreadId: target.value.forkFromThreadId,
          childSessionFileExists: false,
          source,
          pendingTurnStartThreadIds,
        })
      ) {
        return jsonError(
          409,
          `Fork source ${target.value.forkFromThreadId} is mid-turn; forking now would copy an unclosed session. Wait for it to go idle, then workstream_prompt this child again to deliver its kickoff and launch the fork.`,
        );
      }
    }
    // Compose the SAME kickoff the dispatcher would send (D8) — role framing +
    // completion contract — not the raw brief (falls back to the raw brief only
    // for a role-less legacy child).
    kickoffText = kickoffTextForPrompt({
      delivered: false,
      role: target.value.role,
      brief,
      message,
      gateTargetId: gateLoopTargetOf(target.value),
    });
  }

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  // Advisory only (the driver makes the authoritative steer-vs-start call from
  // its live session state): whether the child had an open turn at dispatch.
  const delivery = target.value.session?.activeTurnId ? "steer" : "turn";
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`server:workstream-prompt:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    message: {
      messageId: MessageId.make(yield* crypto.randomUUIDv4),
      role: "user",
      // A parent orchestrator authored this steer/resume for a specific child.
      origin: "orchestrator",
      text: kickoffText,
      attachments: [],
    },
    runtimeMode: target.value.runtimeMode,
    interactionMode: target.value.interactionMode,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    threadId: targetThreadId,
    delivery,
    rendered: `Sent prompt to Workstream child ${targetThreadId} (${
      delivery === "steer" ? "queued as a steer into its open turn" : "starting its next turn"
    }).`,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to prompt the thread."),
    ),
  ),
);

const handleWorkstreamSetDependencies = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamDependenciesRequest => ({})),
  )) as WorkstreamDependenciesRequest;
  const threadId = trimString(body.threadId);
  if (!Array.isArray(body.blockedBy) || !body.blockedBy.every((id) => trimString(id))) {
    return jsonError(400, "blockedBy must be an array of non-empty thread id strings.");
  }

  // Missing threadId defaults to the caller's own thread (always authorised).
  const targetThreadId = threadId ? ThreadId.make(threadId) : scope.threadId;
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  // Trim before branding: ThreadId.make("") throws a defect that escapes the
  // typed Effect.catch, and untrimmed ids silently become dangling deps.
  const blockedBy = body.blockedBy.map((id) => ThreadId.make((id as string).trim()));

  const projection = yield* ProjectionSnapshotQuery;
  const activeSnapshot = yield* projection.getShellSnapshot();
  const target = activeSnapshot.threads.find((thread) => thread.id === targetThreadId);
  if (target === undefined) return jsonError(404, "Target thread was not found or is archived.");
  const siblings = activeSnapshot.threads.filter(
    (thread) => thread.parentThreadId === target.parentThreadId,
  );
  const archivedSnapshot = yield* projection.getArchivedShellSnapshot();
  const archivedSiblings = archivedSnapshot.threads.filter(
    (thread) => thread.parentThreadId === target.parentThreadId,
  );
  const graph = validateSpawnGraph({
    operation: "set-dependencies",
    siblings,
    archivedSiblings,
    blockedBy,
    gateRework: undefined,
    isolationOverride: undefined,
    role: target.role ?? "thread",
    target,
  });
  if (graph.kind === "rejected") return jsonError(400, graph.message);

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.dependencies.set",
    commandId: CommandId.make(`server:workstream-dependencies:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    blockedBy: graph.blockedBy ?? [],
    createdAt: now,
  } satisfies OrchestrationCommand);

  const resultBlockedBy = graph.blockedBy ?? [];
  return HttpServerResponse.jsonUnsafe({
    threadId: targetThreadId,
    blockedBy: resultBlockedBy,
    ...(graph.warnings.length > 0 ? { warnings: graph.warnings } : {}),
    rendered: appendWarnings(
      `Set Workstream thread ${targetThreadId} dependencies (${resultBlockedBy.length} waits-on).`,
      graph.warnings,
    ),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(
        500,
        error instanceof Error ? error.message : "Failed to set Workstream dependencies.",
      ),
    ),
  ),
);

// Review gates (design §3): the single terminal call. Writes the report file
// and dispatches `thread.work.submit`; the decider derives the report pointer,
// the outcome record, and the lane/attention events in ONE transaction.
const handleWorkstreamSubmit = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamSubmitRequest => ({})),
  )) as WorkstreamSubmitRequest;
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
  if (markdown === undefined || markdown.trim().length === 0) {
    return jsonError(400, "markdown is required.");
  }
  const outcome = body.outcome === undefined ? undefined : trimString(body.outcome);
  if (body.outcome !== undefined && outcome === undefined) {
    return jsonError(400, "outcome must be a non-empty string when present.");
  }
  if (
    body.contested !== undefined &&
    (!Array.isArray(body.contested) || !body.contested.every((entry) => trimString(entry)))
  ) {
    return jsonError(400, "contested must be an array of non-empty strings.");
  }
  const counts = body.counts as { mustFix?: unknown; niceToHave?: unknown } | undefined;
  const isCount = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (counts !== undefined && (!isCount(counts.mustFix) || !isCount(counts.niceToHave))) {
    return jsonError(400, "counts must be { mustFix, niceToHave } with non-negative integers.");
  }

  // Routing mirror (shared `routeWorkSubmit`, the same pure decision the
  // decider makes): picks the per-round report file name for loop rounds
  // (risk R2 — conserve every round's prose) and lets the tool response echo
  // the routing decision (risk R5 — "you are not done yet" must be visible).
  const effectiveOutcome = outcome ?? "done";
  const snapshot = yield* (yield* ProjectionSnapshotQuery).getShellSnapshot();
  const self = snapshot.threads.find((thread) => thread.id === scope.threadId);
  const routing =
    self === undefined ? undefined : routeWorkSubmit(self, snapshot.threads, effectiveOutcome);

  // A child may submit only its OWN work; the report is always keyed to the
  // calling thread (no threadId override). Loop rounds write
  // `<threadId>.round-<n>.md`; round 0 / non-gate submits keep `<threadId>.md`.
  const reportPath = yield* writeWorkstreamReport(
    scope.threadId,
    markdown,
    routing?.decision === "loop" ? routing.round : null,
  );

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.work.submit",
    commandId: CommandId.make(`server:workstream-submit:${yield* crypto.randomUUIDv4}`),
    threadId: scope.threadId,
    reportPath,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(Array.isArray(body.contested)
      ? { contested: body.contested.map((entry) => (entry as string).trim()) }
      : {}),
    ...(counts !== undefined
      ? { counts: { mustFix: counts.mustFix as number, niceToHave: counts.niceToHave as number } }
      : {}),
    createdAt: now,
  } satisfies OrchestrationCommand);

  const decision = routing?.decision ?? (effectiveOutcome === "done" ? "terminal" : "yield");
  const disposition =
    decision === "terminal"
      ? "done"
      : decision === "attention"
        ? "needs_human"
        : decision === "loop"
          ? "routed"
          : decision === "resolve"
            ? "resolved"
            : "yielded";
  const loopFields =
    routing !== undefined && decision === "loop"
      ? {
          routedTo: routing.routeTo,
          round: routing.round,
          // The source's findings route to the coder (rework); an intercepted
          // target rework-round submit routes back to the reviewer (reverify).
          leg: (gateLoopTargetOf(self!) === routing.routeTo ? "rework" : "reverify") as
            | "rework"
            | "reverify",
        }
      : undefined;
  const capBreachFields =
    decision === "cap-breach" ? { reason: "cap-breach", round: routing?.round } : undefined;
  return HttpServerResponse.jsonUnsafe({
    threadId: scope.threadId,
    reportPath,
    outcome: effectiveOutcome,
    disposition,
    ...loopFields,
    ...capBreachFields,
    rendered: renderSubmitOutcome({
      disposition,
      outcome: effectiveOutcome,
      ...(loopFields !== undefined ? { leg: loopFields.leg, round: loopFields.round } : {}),
      ...(capBreachFields !== undefined
        ? { reason: capBreachFields.reason, round: capBreachFields.round }
        : {}),
    }),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to submit Workstream work."),
    ),
  ),
);

const handleWorkstreamList = Effect.gen(function* () {
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }
  const threads = yield* collectGraphThreads();
  // Enrich each node with a last-activity signal (the projection's freshness
  // timestamp + one-line preview) and an absolute session jsonl path, so the
  // three-tier read model (report → list+jsonl → consult) needs no bespoke
  // read tool. `sessionPath` is resolved per node from the deterministic pi
  // session id; null until the file first lands on disk.
  const viewThreads = threads.map((thread) => ({
    ...thread,
    lastActivityAt: thread.updatedAt,
    lastActivitySummary: thread.lastActivityPreview,
  }));
  // Proactive model discoverability: the same catalogue the spawn validator
  // checks against, plus each configured preset resolved (with a validity flag)
  // so an orchestrator can read valid instance ids / model slugs before spawning
  // instead of guessing and hitting the fail-fast 400 — and is never pointed at a
  // stale preset that would still strand the child.
  const catalogue = modelCatalogueOf(yield* (yield* ProviderRegistry).getProviders);
  const settings = yield* (yield* ServerSettingsService).getSettings;
  // The caller is implicitly in its own tree; no target arg, no 403 path.
  const view = {
    ...graphViewFor(
      scope.threadId,
      viewThreads,
      (id) => resolveSessionFilePath(piSessionIdForThread(id)) ?? null,
    ),
    modelCatalogue: catalogue,
    modelPresets: presetCatalogueOf(
      settings.workstreamModelPresets as Record<string, ModelSelection>,
      catalogue,
    ),
    taskShapes: TASK_SHAPES,
    modelProfiles: profileSummaryOf(
      settings.workstreamModelProfiles as Record<string, WorkstreamModelProfile>,
      catalogue,
    ),
  };
  return HttpServerResponse.jsonUnsafe({ ...view, rendered: renderWorkstreamList(view) });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to list the workstream."),
    ),
  ),
);

/**
 * USER-DIRECTED consult: a GLOBAL-scope read-only Q&A over another thread (every
 * thread the server knows, across worktrees/projects). It identifies the target either by
 * an exact `threadId` (e.g. injected by an @-mention) or by a fuzzy `name`. A
 * name with one clear match runs the read-only consult; an ambiguous name
 * returns ranked candidates for the caller to confirm with the user (consulting
 * the wrong thread is costly). The target session is resolved to its absolute
 * `.jsonl` path so the read-only fork locates it even in a different worktree.
 * The execution core (`askWorkstreamThread`) is reused unchanged.
 */
const handleWorkstreamConsultThread = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }
  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamConsultThreadRequest => ({})),
  )) as WorkstreamConsultThreadRequest;
  const threadId = trimString(body.threadId);
  const name = trimString(body.name);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!threadId && !name) return jsonError(400, "Provide either threadId or name.");
  if (question.length === 0) return jsonError(400, "question is required.");
  if (question.length > ASK_QUESTION_MAX_CHARS) {
    return jsonError(400, `question must be at most ${ASK_QUESTION_MAX_CHARS} characters.`);
  }

  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const threads = yield* collectGraphThreads();

  // Resolve the target to its absolute session path (bare id fallback) so the
  // read-only fork locates it regardless of which worktree/project it lives in;
  // retain the fork jsonl under userdata for deep inspection; and record the
  // resolved consult as a durable `thread.consult-recorded` event on the ASKER
  // (best-effort — a recording failure must never fail the consult response).
  const asker = threads.find((thread) => thread.id === scope.threadId);
  const consult = (shell: (typeof threads)[number]) =>
    Effect.gen(function* () {
      const freshSessionId = yield* crypto.randomUUIDv4;
      const sessionId = piSessionIdForThread(shell.id);
      const startedAt = yield* DateTime.now;
      const { answer, forkSessionPath } = yield* askWorkstreamThread({
        binaryPath: settings.providers.pi.binaryPath,
        targetSessionId: resolveSessionFilePath(sessionId) ?? sessionId,
        freshSessionId,
        cwd: shell.worktreePath ?? config.cwd,
        question,
        asker: composeConsultAsker({
          askerTitle: asker?.title ?? "a thread",
          askerRole: asker?.role ?? "thread",
          askerThreadId: scope.threadId,
          relationship: notifyRelationshipLabel({
            senderThreadId: scope.threadId,
            senderParentThreadId: asker?.parentThreadId ?? null,
            targetThreadId: shell.id,
            targetParentThreadId: shell.parentThreadId,
          }),
        }),
        timeoutMs: ASK_TIMEOUT_MS,
        forkRetentionDir: config.workstreamConsultsDir,
      });
      const finishedAt = yield* DateTime.now;
      yield* engine
        .dispatch({
          type: "thread.consult.record",
          commandId: CommandId.make(`server:consult-thread:${freshSessionId}`),
          threadId: scope.threadId,
          targetThreadId: shell.id,
          targetTitle: shell.title,
          question,
          answer,
          resolved: true,
          durationMs: Math.max(
            0,
            DateTime.toEpochMillis(finishedAt) - DateTime.toEpochMillis(startedAt),
          ),
          ...(forkSessionPath !== undefined ? { forkSessionPath } : {}),
          createdAt: DateTime.formatIso(finishedAt),
        } satisfies OrchestrationCommand)
        .pipe(
          Effect.catch((cause: unknown) =>
            Effect.logWarning("failed to record consult_thread event", {
              askerThreadId: scope.threadId,
              targetThreadId: shell.id,
              cause,
            }),
          ),
        );
      return answer;
    });

  if (threadId) {
    const target = ThreadId.make(threadId);
    const shell = threads.find((thread) => thread.id === target);
    if (shell === undefined) return jsonError(404, "Target thread was not found.");
    const answer = yield* consult(shell);
    return HttpServerResponse.jsonUnsafe({
      resolved: true,
      threadId: target,
      title: shell.title,
      answer,
      rendered: answer,
    });
  }

  const ranked = rankThreadsByName(name!, threads);
  if (ranked.length === 0) {
    return jsonError(404, `No thread matches "${name}".`);
  }
  if (isUnambiguousMatch(ranked)) {
    const shell = ranked[0]!.thread;
    const answer = yield* consult(shell);
    return HttpServerResponse.jsonUnsafe({
      resolved: true,
      threadId: shell.id,
      title: shell.title,
      answer,
      rendered: answer,
    });
  }
  const candidates = ranked.slice(0, CONSULT_CANDIDATE_LIMIT).map((entry) => ({
    threadId: entry.thread.id,
    title: entry.thread.title,
    role: entry.thread.role,
    planLane: entry.thread.planLane,
    projectId: entry.thread.projectId,
    worktreePath: entry.thread.worktreePath,
  }));
  return HttpServerResponse.jsonUnsafe({
    resolved: false,
    candidates,
    rendered: renderConsultCandidates(candidates),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(502, error instanceof Error ? error.message : "Failed to consult the thread."),
    ),
  ),
);

// notify_thread (cross-thread push): the injected inputs + dependencies of the
// handler's post-scope-resolution orchestration core. Extracted (like
// `composeNotifyFramedText`) so the record-before-send safety invariant,
// disposition mapping, and rejection branches are testable without an HTTP /
// MCP-credential harness.
export interface NotifyThreadInput {
  readonly scopeThreadId: ThreadId;
  /** Trimmed threadId / name from the request body (exactly one must be set). */
  readonly threadId: string | undefined;
  readonly name: string | undefined;
  /** Trimmed raw message body (validated inside the core). */
  readonly message: string;
}

export interface NotifyThreadDeps {
  /** The global graph (active + archived shells) the target resolves against. */
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  /** Thread detail lookup for the unstarted-child predicate (shells carry no messages). */
  readonly getThreadDetail: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Option.Option<{ readonly messages: ReadonlyArray<{ readonly role: string }> }>,
    ProjectionRepositoryError
  >;
  /** Whether the target's kickoff was durably delivered (launch-identity marker). */
  readonly isKickoffDelivered: (threadId: ThreadId) => boolean;
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>;
  /** Fresh uuid (record id / message id). */
  readonly newId: Effect.Effect<string, PlatformError.PlatformError>;
  /** Current ISO timestamp. */
  readonly now: Effect.Effect<string, PlatformError.PlatformError>;
}

export type NotifyThreadOutcome =
  | { readonly kind: "error"; readonly status: number; readonly message: string }
  | { readonly kind: "candidates"; readonly candidates: ReadonlyArray<ConsultCandidate> }
  | {
      readonly kind: "delivered" | "queued";
      readonly threadId: ThreadId;
      readonly title: string;
    };

// The handler's orchestration core, after scope resolution + body parsing. Owns
// the hard invariants: exactly-one-of id/name, self / terminal / archived /
// unstarted-child rejection, and RECORD-BEFORE-SEND (dispatch
// `thread.peer-message.record` FIRST; only on its success dispatch the delivery
// turn-start; a failed record fails the call and sends nothing). Returns a
// structured outcome the HTTP wrapper maps to a response.
export const runNotifyThread = (
  input: NotifyThreadInput,
  deps: NotifyThreadDeps,
): Effect.Effect<
  NotifyThreadOutcome,
  OrchestrationDispatchError | ProjectionRepositoryError | PlatformError.PlatformError
> =>
  Effect.gen(function* () {
    const { scopeThreadId, threadId, name, message } = input;
    const err = (status: number, msg: string): NotifyThreadOutcome => ({
      kind: "error",
      status,
      message: msg,
    });
    // Exactly one of threadId / name identifies the target: for a side-effectful
    // send, silent precedence would hide a caller bug (D10).
    if (threadId && name) return err(400, "Provide exactly one of threadId or name, not both.");
    if (!threadId && !name) return err(400, "Provide either threadId or name.");
    if (message.length === 0) return err(400, "message is required.");
    if (message.length > NOTIFY_MESSAGE_MAX_CHARS) {
      return err(
        400,
        `message must be at most ${NOTIFY_MESSAGE_MAX_CHARS} characters; reference bulk content by absolute path instead of pasting it inline.`,
      );
    }

    const sender = deps.threads.find((thread) => thread.id === scopeThreadId);

    // Resolve the target shell (exactly-one-of id/name, consult-style ranking).
    let target: OrchestrationThreadShell;
    if (threadId) {
      const resolved = deps.threads.find((thread) => thread.id === ThreadId.make(threadId));
      if (resolved === undefined) return err(404, "Target thread was not found.");
      target = resolved;
    } else {
      const ranked = rankThreadsByName(name!, deps.threads);
      if (ranked.length === 0) return err(404, `No thread matches "${name}".`);
      if (!isUnambiguousMatch(ranked)) {
        // An ambiguous name SENDS NOTHING (a misdelivered push engages the wrong
        // thread's session) and returns ranked candidates.
        return {
          kind: "candidates",
          candidates: ranked.slice(0, CONSULT_CANDIDATE_LIMIT).map((entry) => ({
            threadId: entry.thread.id,
            title: entry.thread.title,
            role: entry.thread.role,
            planLane: entry.thread.planLane,
            projectId: entry.thread.projectId,
            worktreePath: entry.thread.worktreePath,
          })),
        };
      }
      target = ranked[0]!.thread;
    }

    // D3 rejections (sanity, not ownership): notify is global.
    if (target.id === scopeThreadId) return err(400, "You cannot notify your own thread.");
    if (target.planLane === "done" || target.planLane === "cancelled") {
      return err(
        409,
        `Thread is ${target.planLane}; a push would silently re-engage a terminal thread. Notify its parent instead, or wait for a live thread.`,
      );
    }
    if (target.archivedAt !== null) {
      return err(
        409,
        "Thread is archived; an archived thread must not accrue new turns. consult_thread can read it, but a push cannot engage it.",
      );
    }
    // Unstarted-child: a peer message must never become a child's FIRST turn.
    // Shells carry no messages, so fetch DETAIL and apply the same predicate
    // workstream_prompt uses (kickoff-delivered marker OR any assistant message).
    if (target.parentThreadId !== null) {
      const detail = yield* deps.getThreadDetail(target.id);
      const kickoffDelivered =
        Option.isSome(detail) &&
        (deps.isKickoffDelivered(target.id) ||
          detail.value.messages.some((entry) => entry.role === "assistant"));
      if (!kickoffDelivered) {
        return err(
          409,
          "Target has not started yet; its kickoff belongs to its parent. Notify the parent, or wait for the target to launch.",
        );
      }
    }

    // D5 framing (relationship-aware), composed + persisted at record time.
    const framedText = composeNotifyFramedText({
      senderTitle: sender?.title ?? "a thread",
      senderRole: sender?.role ?? "thread",
      senderThreadId: scopeThreadId,
      relationship: notifyRelationshipLabel({
        senderThreadId: scopeThreadId,
        senderParentThreadId: sender?.parentThreadId ?? null,
        targetThreadId: target.id,
        targetParentThreadId: target.parentThreadId,
      }),
      message,
    });

    const recordId = yield* deps.newId;
    const now = yield* deps.now;

    // RECORD FIRST (durable enqueue + cap ledger + edge). A failed record fails
    // the call and sends NOTHING. The decider's only expected rejection here is
    // the D7 cap (existence/self/terminal already checked), surfaced as 429.
    const recordResult = yield* deps
      .dispatch({
        type: "thread.peer-message.record",
        commandId: CommandId.make(notifyRecordCommandId(recordId)),
        threadId: scopeThreadId,
        recordId,
        targetThreadId: target.id,
        targetTitle: target.title,
        message,
        framedMessage: framedText,
        createdAt: now,
      } satisfies OrchestrationCommand)
      .pipe(
        Effect.as({ ok: true as const }),
        Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
          Effect.succeed({ ok: false as const, detail: error.detail }),
        ),
      );
    if (!recordResult.ok) return err(429, recordResult.detail);

    // Only AFTER a successful record: attempt immediate delivery on an idle
    // recipient. `requireIdle` re-checks idleness (and, for notify, liveness)
    // atomically in the serial boundary: accept commits to the transcript
    // (`delivered`); a busy/terminal target raises OrchestrationCommandDeferredError
    // WITHOUT a receipt, so the deterministic id stays redeliverable (`queued`).
    const disposition = yield* deps
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(notifyDeliverCommandId(recordId)),
        threadId: target.id,
        message: {
          messageId: MessageId.make(yield* deps.newId),
          role: "user",
          origin: "notify",
          text: framedText,
          attachments: [],
        },
        titleSeed: target.title,
        requireIdle: true,
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        createdAt: now,
      } satisfies OrchestrationCommand)
      .pipe(
        Effect.as("delivered" as const),
        Effect.catchTag("OrchestrationCommandDeferredError", () =>
          Effect.succeed("queued" as const),
        ),
      );

    if (disposition === "delivered") {
      // Committed to the transcript: mark the queue row delivered (idempotent;
      // the dispatcher rail's reconciliation leg would otherwise do this).
      yield* deps.dispatch({
        type: "thread.peer-message.mark-delivered",
        commandId: CommandId.make(notifyMarkCommandId(recordId)),
        threadId: scopeThreadId,
        recordId,
        createdAt: yield* deps.now,
      } satisfies OrchestrationCommand);
    }

    return { kind: disposition, threadId: target.id, title: target.title };
  });

// notify_thread (cross-thread push): the global-scope WRITE counterpart of
// consult_thread. The HTTP wrapper resolves scope + parses the body, then
// delegates to `runNotifyThread` (the tested DI'd core) and maps its structured
// outcome to a response. Never interrupts; never claims the recipient acted.
const handleNotifyThread = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }
  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): NotifyThreadRequest => ({})),
  )) as NotifyThreadRequest;

  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const { workstreamLaunchIdentityDir } = yield* ServerConfig;
  const threads = yield* collectGraphThreads();

  const outcome = yield* runNotifyThread(
    {
      scopeThreadId: scope.threadId,
      threadId: trimString(body.threadId),
      name: trimString(body.name),
      message: typeof body.message === "string" ? body.message.trim() : "",
    },
    {
      threads,
      getThreadDetail: (id) => projection.getThreadDetailById(id),
      isKickoffDelivered: (id) => isKickoffDelivered(workstreamLaunchIdentityDir, id),
      dispatch: (command) => engine.dispatch(command),
      newId: crypto.randomUUIDv4,
      now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    },
  );

  switch (outcome.kind) {
    case "error":
      return jsonError(outcome.status, outcome.message);
    case "candidates":
      return HttpServerResponse.jsonUnsafe({
        resolved: false,
        candidates: outcome.candidates,
        rendered: renderNotifyCandidates(outcome.candidates),
      });
    default:
      return HttpServerResponse.jsonUnsafe({
        disposition: outcome.kind,
        threadId: outcome.threadId,
        title: outcome.title,
        rendered: renderNotifyDisposition({
          disposition: outcome.kind,
          targetThreadId: outcome.threadId,
          targetTitle: outcome.title,
        }),
      });
  }
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to notify the thread."),
    ),
  ),
);

// A thread renames its OWN sidebar title. The title is always keyed to the
// calling thread (no threadId override — renaming an arbitrary thread is
// structurally impossible). Dispatches the existing `thread.meta.update`
// command (one source of truth); a later rename naturally wins over the
// auto-from-first-message title.
const handleSetThreadTitle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): SetThreadTitleRequest => ({})),
  )) as SetThreadTitleRequest;
  const title = trimString(body.title);
  if (!title) return jsonError(400, "title must be a non-empty string.");

  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.meta.update",
    commandId: CommandId.make(`server:set-thread-title:${yield* crypto.randomUUIDv4}`),
    threadId: scope.threadId,
    title,
    titleProvenance: "curated", // loom: §4 set_thread_title is a human/tool rename
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    threadId: scope.threadId,
    title,
    rendered: `Set this thread's title to "${title}".`,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to set the thread title."),
    ),
  ),
);

export const workstreamSpawnRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_spawn,
  handleWorkstreamSpawn,
);
export const workstreamScaffoldRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_scaffold,
  handleWorkstreamScaffold,
);
export const workstreamBriefRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_brief,
  handleWorkstreamBrief,
);
export const workstreamLaneRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_set_lane,
  handleWorkstreamSetLane,
);
export const workstreamAttentionRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_request_attention,
  handleWorkstreamRequestAttention,
);
export const workstreamReleaseRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_release,
  handleWorkstreamRelease,
);
export const workstreamStopRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_stop,
  handleWorkstreamStop,
);
export const workstreamPromptRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_prompt,
  handleWorkstreamPrompt,
);
export const workstreamDependenciesRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_set_dependencies,
  handleWorkstreamSetDependencies,
);
export const workstreamSubmitRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_submit,
  handleWorkstreamSubmit,
);
export const workstreamListRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.workstream_list,
  handleWorkstreamList,
);
export const workstreamConsultThreadRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.consult_thread,
  handleWorkstreamConsultThread,
);
export const notifyThreadRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.notify_thread,
  handleNotifyThread,
);
export const setThreadTitleRouteLayer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.set_thread_title,
  handleSetThreadTitle,
);

export const layer = Layer.mergeAll(
  workstreamSpawnRouteLayer,
  workstreamScaffoldRouteLayer,
  workstreamBriefRouteLayer,
  workstreamLaneRouteLayer,
  workstreamAttentionRouteLayer,
  workstreamReleaseRouteLayer,
  workstreamStopRouteLayer,
  workstreamPromptRouteLayer,
  workstreamDependenciesRouteLayer,
  workstreamSubmitRouteLayer,
  workstreamListRouteLayer,
  workstreamConsultThreadRouteLayer,
  notifyThreadRouteLayer,
  setThreadTitleRouteLayer,
);
