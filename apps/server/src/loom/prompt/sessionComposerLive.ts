/**
 * The production session composer (Phase 3a-5).
 *
 * The prompt, in reading order: the work-model addendum, the child-readership
 * clause (children only), the identity clause, the role overlay, the ship
 * policy, the role catalogue (only when the surface delegates), the goal
 * context, and — appended per launch, never recorded — the relocation clause.
 * Everything but the relocation clause is the thread's launch identity: written
 * once at its first compose and replayed verbatim by every later compose, and
 * by a `forkFrom` child's or a V2 fork's (thread_fork) first compose (P3-23) —
 * that first launch only: the fork's next compose is its own (DL-740, V1's
 * fork-once replay).
 * Two drafter exceptions (DL-450): a `retro-reviewer` diverges in role from the thread it reviews, so
 * it composes its own identity with its server-owned overlay (V1's
 * `forkIdentity: "compose"`); a `handoff-drafter` replays its source when the
 * source has a record and composes fresh when it has none (an upstream-only
 * thread the human was chatting to). `env` carries `PI_CACHE_RETENTION` (DL-300), the
 * arm for life, and, per launch, the agent git identity, whose shim directory rides
 * `pathPrepend`. A 1-hour root's launch adds, outside the identity, the keep-alive
 * policy: pi's idle-warming horizon and a longer idle release.
 * A goal-less root's first compose waits, bounded, for its emergent goal; a goal that differs
 * from the frozen identity's later reaches the agent as a turn notice (`goalNotice`), never as a
 * prompt rewrite.
 *
 * @module loom/prompt/sessionComposerLive
 */
import {
  LOOM_CACHE_HORIZON_MS,
  type LoomThreadWorkstream,
  type OrchestrationV2AppThread,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveMergeAuthority, shipPolicyPromptBlock } from "@t3tools/shared/shipPolicy";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import {
  cacheRetentionForThread,
  LONG_ROOT_IDLE_TIMEOUT_MS,
  recordCacheRetentionLaunch,
} from "../../provider/cacheRetention.loom.ts";
import {
  LoomExtensionPath,
  LoomExtensionPathLive,
} from "../../provider/Drivers/Pi/loomExtension.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { HANDOFF_DRAFTER_ROLE } from "../handoff/handoffDraft.ts";
import { RETRO_REVIEWER_OVERLAY_PROMPT, RETRO_REVIEWER_ROLE } from "../handoff/retroDraft.ts";
import { loomPaths } from "../loomPaths.ts";
import { agentGitEnv, materializeGitShim } from "../workstream/agentGitIdentity.ts";
import * as LoomStore from "../projection/LoomStore.ts";
import {
  type LaunchIdentityRecord,
  readLaunchIdentity,
  writeLaunchIdentity,
} from "../workstream/launchIdentity.ts";
import * as EmergentGoalGate from "../orchestration/emergentGoalGate.ts";
import { goalChangeNotice, goalContextInstruction, promptGoalId } from "./goalContext.ts";
import {
  CHILD_READERSHIP_CLAUSE,
  relocationClause,
  threadIdentityClause,
  WORK_MODEL_ADDENDUM,
} from "./prose.ts";
import { listRoleOverlays, loadRoleOverlay } from "./roleOverlay.ts";
import {
  LoomSessionComposer,
  LoomSessionComposerError,
  type LoomSessionComposerShape,
} from "./sessionComposer.ts";
import type { LoomOpenSessionFields } from "@t3tools/contracts";
import { T3_LOOM_HIDDEN_TOOLS_ENV } from "@t3tools/provider-pi/server/mcpExtensionSource";
import { UPSTREAM_WITHHELD_TOOLS } from "../../mcp/toolkits/workstream/families.ts";

/** Withheld tools as the bridge names them (unprefixed): registered `hidden`, so `tool_search` cannot surface them. */
export const LOOM_HIDDEN_TOOLS_ENV = {
  [T3_LOOM_HIDDEN_TOOLS_ENV]: JSON.stringify(
    UPSTREAM_WITHHELD_TOOLS.map((name) => name.replace(/^mcp__t3-code__/, "")),
  ),
};

/**
 * How long a goal-less root's first launch waits for its emergent goal (`EmergentGoalGate`) so
 * the goal lands in the launch identity. The derivation takes about 7 s from the user's message
 * (11.5 s at most across 43 recorded ones); worktree preparation overlaps part of it. Past the
 * cap a stuck generation would only hold up the first turn (and an effect-worker slot); its goal
 * still reaches the agent as a goal-change notice.
 */
const FIRST_LAUNCH_GOAL_WAIT = "15 seconds";

/** A `forkFrom` child whose source never launched has nothing to replay (V1's loud refusal). */
export class LoomForkSourceIdentityMissing extends Schema.TaggedError<LoomForkSourceIdentityMissing>()(
  "LoomForkSourceIdentityMissing",
  { threadId: ThreadId, sourceThreadId: ThreadId },
) {
  override get message() {
    return `Thread ${this.threadId} forks ${this.sourceThreadId}, which has no launch identity to replay; it must have launched first.`;
  }
}

export const makeLoomSessionComposer = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const loomStore = yield* LoomStore.LoomStoreV2;
  const settings = yield* ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const extensionPath = yield* LoomExtensionPath;
  const identityDir = loomPaths(config).workstreamLaunchIdentityDir;
  const emergentGoals = yield* EmergentGoalGate.EmergentGoalGate;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const gitShimDir = yield* materializeGitShim(
    (yield* Path.Path).join(config.providerStatusCacheDir, "loom-bin"),
  );

  /** The thread's goal as a launch now would name it: none when unset or deleted. */
  const currentGoal = (workstream: LoomThreadWorkstream | null) =>
    workstream?.goalId == null
      ? Effect.succeed(null)
      : loomStore.goals
          .get(workstream.goalId)
          .pipe(Effect.map((goal) => (goal === null || goal.deletedAt !== null ? null : goal)));

  /** The thread's identity from scratch: its role, ship policy, catalogue and goal as of now. */
  const composeIdentity = (
    thread: OrchestrationV2AppThread,
    workstream: LoomThreadWorkstream | null,
    projectRoot: string,
    longShare: number,
  ) =>
    Effect.gen(function* () {
      // A V2 `fork` (thread_fork, a UI fork) is a root the human drives; only `subagent` is a child.
      const isChild = thread.lineage.relationshipToParent === "subagent";
      const overlay =
        workstream?.role === RETRO_REVIEWER_ROLE
          ? { prompt: RETRO_REVIEWER_OVERLAY_PROMPT, delegation: false }
          : loadRoleOverlay({ role: workstream?.role ?? null, projectRoot });
      const catalogue =
        overlay === undefined || overlay.delegation ? listRoleOverlays({ projectRoot }) : [];
      const goal = yield* currentGoal(workstream);
      const appendSystemPrompt = [
        WORK_MODEL_ADDENDUM,
        isChild ? CHILD_READERSHIP_CLAUSE : undefined,
        threadIdentityClause(thread.id, isChild ? thread.lineage.parentThreadId : null),
        overlay?.prompt,
        shipPolicyPromptBlock(resolveMergeAuthority(projectRoot)),
        catalogue.length > 0
          ? [
              "Available roles for spawning children (built in; a project may add its own under `.t3code/roles/`). A free-text role may still be used when none fits:",
              ...catalogue.map((role) => `- ${role.name}: ${role.summary}`),
            ].join("\n")
          : undefined,
        goal === null
          ? undefined
          : goalContextInstruction(goal, {
              asChildBackground: isChild,
              anchorTaskId: workstream?.anchorTaskId ?? null,
            }),
      ]
        .filter((part): part is string => part !== undefined && part.trim().length > 0)
        .join("\n\n");
      return {
        appendSystemPrompt,
        skills: overlay?.skills ?? [],
        extensions: [extensionPath],
        env: {
          PI_CACHE_RETENTION: cacheRetentionForThread(thread.id, !isChild, longShare),
        },
        modelSelection: thread.modelSelection,
        tools: overlay?.tools ?? [],
      } satisfies LaunchIdentityRecord;
    });

  /**
   * Own record → the fork source's record verbatim → a fresh composition; first one written.
   * A replayed record serves the fork's first launch only; its next compose is fresh and final.
   * The source is a `forkFrom` child's sibling, which must have a record, or a V2 fork's
   * lineage parent (thread_fork, a UI fork), which composes fresh as a root when it has none
   * (a V1-imported source never relaunched under V2).
   */
  const launchIdentity = (
    thread: OrchestrationV2AppThread,
    workstream: LoomThreadWorkstream | null,
    projectRoot: string,
    longShare: number,
  ) =>
    Effect.gen(function* () {
      const own = yield* readLaunchIdentity(identityDir, thread.id);
      if (Option.isSome(own) && own.value.replayedFrom === undefined) return own.value;
      const firstLaunch = Option.isNone(own);
      const forkFrom =
        !firstLaunch || workstream?.role === RETRO_REVIEWER_ROLE
          ? null
          : (workstream?.forkFromThreadId ?? null);
      const sourceThreadId =
        forkFrom ??
        (firstLaunch && thread.lineage.relationshipToParent === "fork"
          ? thread.lineage.parentThreadId
          : null);
      const source =
        sourceThreadId === null
          ? Option.none<LaunchIdentityRecord>()
          : Option.map(yield* readLaunchIdentity(identityDir, sourceThreadId), (record) => ({
              ...record,
              replayedFrom: sourceThreadId,
            }));
      if (forkFrom !== null && Option.isNone(source) && workstream?.role !== HANDOFF_DRAFTER_ROLE)
        return yield* Effect.fail(
          new LoomForkSourceIdentityMissing({ threadId: thread.id, sourceThreadId: forkFrom }),
        );
      // A goal-less root's first launch waits (bounded) for its emergent goal, then re-reads.
      const settled =
        firstLaunch && Option.isNone(source) && (workstream?.goalId ?? null) === null
          ? yield* emergentGoals
              .settle(thread.id)
              .pipe(
                Effect.timeout(FIRST_LAUNCH_GOAL_WAIT),
                Effect.ignore({ log: true }),
                Effect.andThen(loomStore.getWorkstream(thread.id)),
              )
          : workstream;
      const record = Option.isSome(source)
        ? source.value
        : yield* composeIdentity(thread, settled, projectRoot, longShare);
      yield* writeLaunchIdentity(identityDir, thread.id, record);
      return record;
    });

  const compose = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { thread, providerSessions } = yield* projections.getThreadRecords(threadId, [
        "providerSessions",
      ]);
      const cwd =
        thread.worktreePath ??
        Option.getOrNull(
          Option.map(yield* projects.get(thread.projectId), (project) => project.workspaceRoot),
        );
      const { rootCacheLongShare } = yield* settings.getSettings;
      const identity = yield* launchIdentity(
        thread,
        yield* loomStore.getWorkstream(threadId),
        cwd ?? process.cwd(),
        rootCacheLongShare,
      );
      const retention = identity.env.PI_CACHE_RETENTION;
      if (retention === "long" || retention === "short") {
        yield* Effect.sync(() =>
          recordCacheRetentionLaunch(config.stateDir, threadId, retention, rootCacheLongShare),
        );
        // The sidebar's cache indicator; never worth failing a launch over.
        yield* loomStore.cache.record(threadId, retention).pipe(Effect.ignore({ log: true }));
      }
      // A session that ran in another directory remembers paths that are now historical.
      const relocated = cwd !== null && providerSessions.some((session) => session.cwd !== cwd);
      return {
        appendSystemPrompt: relocated
          ? `${identity.appendSystemPrompt}\n\n${relocationClause({ cwd })}`
          : identity.appendSystemPrompt,
        skills: identity.skills,
        extensions: identity.extensions,
        // Per thread, never replayed: a fork commits under its own thread id.
        env: {
          ...identity.env,
          ...agentGitEnv(threadId),
          ...LOOM_HIDDEN_TOOLS_ENV,
          ...(retention === "long" && {
            PI_CACHE_WARMING_IDLE_MAX_MS: String(LOOM_CACHE_HORIZON_MS.long),
          }),
        },
        pathPrepend: gitShimDir,
        ...(retention === "long" && { idleTimeoutMs: LONG_ROOT_IDLE_TIMEOUT_MS }),
      } satisfies LoomOpenSessionFields;
    }).pipe(
      Effect.provide(context),
      Effect.mapError((cause) => new LoomSessionComposerError({ threadId, cause })),
    );

  /**
   * Once per change: when the thread's goal is not the one the agent last saw — its frozen
   * prompt's goal block, or the last notice — the notice naming the current one, recorded on the
   * identity (outside the prompt bytes). Nothing before the first launch, whose prompt is current.
   */
  const goalNotice = (threadId: ThreadId, runId: RunId) =>
    Effect.gen(function* () {
      const own = yield* readLaunchIdentity(identityDir, threadId);
      if (Option.isNone(own)) return null;
      const workstream = yield* loomStore.getWorkstream(threadId);
      const goal = yield* currentGoal(workstream);
      const seen = own.value.goalNotice;
      const seenGoalId =
        seen === undefined ? promptGoalId(own.value.appendSystemPrompt) : seen.goalId;
      if ((goal?.id ?? null) === seenGoalId && seen?.runId !== runId) return null;
      yield* writeLaunchIdentity(identityDir, threadId, {
        ...own.value,
        goalNotice: { goalId: goal?.id ?? null, runId },
      });
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      return goalChangeNotice(goal, {
        asChildBackground: thread.lineage.relationshipToParent === "subagent",
        anchorTaskId: workstream?.anchorTaskId ?? null,
      });
    }).pipe(
      Effect.provide(context),
      Effect.mapError((cause) => new LoomSessionComposerError({ threadId, cause })),
    );

  return { compose, goalNotice } satisfies LoomSessionComposerShape;
});

/** The production composer; its reads are provided here, the server-wide services are not. */
export const LoomSessionComposerRealLive = Layer.effect(
  LoomSessionComposer,
  makeLoomSessionComposer,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionStore.layer,
      ProjectStore.layer,
      LoomStore.layer,
      LoomExtensionPathLive,
      EmergentGoalGate.layer,
    ),
  ),
);
