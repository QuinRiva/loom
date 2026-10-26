/**
 * The production session composer. All but the per-launch relocation clause is launch identity,
 * written at first compose and replayed later, and by a fork's first launch only. A `retro-reviewer`
 * composes with its overlay; a `handoff-drafter` replays its source's record (or composes fresh); a
 * `document-query` thread replays its author's current record every launch, plus `T3_LOOM_QUERY_FORK`.
 */
import {
  DOCUMENT_QUERY_ROLE,
  LOOM_CACHE_HORIZON_MS,
  type LoomThreadWorkstream,
  type OrchestrationV2AppThread,
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
import { LOOM_QUERY_FORK_ENV } from "../query/queryPosture.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { HANDOFF_DRAFTER_ROLE } from "../handoff/handoffDraft.ts";
import { RETRO_REVIEWER_OVERLAY_PROMPT, RETRO_REVIEWER_TOOLS } from "../handoff/retroDraft.ts";
import { RETRO_REVIEWER_ROLE } from "../handoff/retroRole.ts";
import { loomPaths } from "../loomPaths.ts";
import { agentGitEnv, materializeGitShim } from "../workstream/agentGitIdentity.ts";
import * as LoomStore from "../projection/LoomStore.ts";
import {
  type LaunchIdentityRecord,
  readLaunchIdentity,
  writeLaunchIdentity,
} from "../workstream/launchIdentity.ts";
import { goalContextInstruction } from "./goalContext.ts";
import {
  CHILD_READERSHIP_CLAUSE,
  deferredCapabilitiesClause,
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
import { CAPABILITIES, withheldFrom } from "../../mcp/toolkits/workstream/families.ts";

/**
 * The tools withheld from this profile, as the bridge names them (unprefixed): registered
 * `hidden`, so `tool_search` cannot surface them and the profile cannot activate them.
 */
export const loomHiddenToolsEnv = (tools: ReadonlyArray<string>) => ({
  [T3_LOOM_HIDDEN_TOOLS_ENV]: JSON.stringify(
    withheldFrom(tools).map((name) => name.replace(/^mcp__t3-code__/, "")),
  ),
});

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
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const gitShimDir = yield* materializeGitShim(
    (yield* Path.Path).join(config.providerStatusCacheDir, "loom-bin"),
  );

  /** The thread's identity from scratch: its role, ship policy, catalogue and goal as of now. */
  const composeIdentity = Effect.fn("sessionComposerLive.composeIdentity")(function* (
    thread: OrchestrationV2AppThread,
    workstream: LoomThreadWorkstream | null,
    projectRoot: string,
    longShare: number,
  ) {
    // A V2 `fork` (thread_fork, a UI fork) is a root the human drives; only `subagent` is a child.
    const isChild = thread.lineage.relationshipToParent === "subagent";
    const overlay =
      workstream?.role === RETRO_REVIEWER_ROLE
        ? {
            prompt: RETRO_REVIEWER_OVERLAY_PROMPT,
            delegation: false,
            tools: RETRO_REVIEWER_TOOLS,
          }
        : loadRoleOverlay({ role: workstream?.role ?? null, projectRoot });
    const catalogue = overlay.delegation ? listRoleOverlays({ projectRoot }) : [];
    const goal = workstream?.goalId == null ? null : yield* loomStore.goals.get(workstream.goalId);
    // The retro reviewer's profile is its whole job: nothing to announce behind tool_search.
    const resident = workstream?.role === RETRO_REVIEWER_ROLE ? undefined : new Set(overlay.tools);
    const appendSystemPrompt = [
      WORK_MODEL_ADDENDUM,
      resident &&
        deferredCapabilitiesClause(
          CAPABILITIES.filter((capability) => capability.tools.some((tool) => !resident.has(tool))),
        ),
      isChild ? CHILD_READERSHIP_CLAUSE : undefined,
      threadIdentityClause(
        thread.id,
        isChild ? thread.lineage.parentThreadId : null,
        loomPaths(config),
      ),
      overlay.prompt,
      shipPolicyPromptBlock(resolveMergeAuthority(projectRoot)),
      catalogue.length > 0
        ? [
            "Available roles for spawning children (built in; a project may add its own under `.t3code/roles/`). A free-text role may still be used when none fits:",
            ...catalogue.map((role) => `- ${role.name}: ${role.summary}`),
          ].join("\n")
        : undefined,
      // A root the human or a handoff starts has said nothing yet that a goal could
      // summarise; only a root joining work in progress (its goal already has tasks) needs it.
      goal === null || goal.deletedAt !== null || (!isChild && goal.tasks.length === 0)
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
      skills: overlay.skills ?? [],
      extensions: [extensionPath],
      env: {
        PI_CACHE_RETENTION: cacheRetentionForThread(thread.id, !isChild, longShare),
      },
      modelSelection: thread.modelSelection,
      tools: overlay.tools,
    } satisfies LaunchIdentityRecord;
  });

  /**
   * Own record → the fork source's record verbatim → a fresh composition; the first one is written.
   * A replayed record serves the fork's first launch only. The source is a `forkFrom` child's
   * sibling (must have a record) or a V2 fork's lineage parent, which composes fresh as a root when
   * it has none (a V1-imported source never relaunched under V2).
   */
  const launchIdentity = Effect.fn("sessionComposerLive.launchIdentity")(function* (
    thread: OrchestrationV2AppThread,
    workstream: LoomThreadWorkstream | null,
    projectRoot: string,
    longShare: number,
  ) {
    if (workstream?.role === DOCUMENT_QUERY_ROLE && workstream.forkFromThreadId !== null) {
      const author = workstream.forkFromThreadId;
      const source = yield* readLaunchIdentity(identityDir, author);
      if (Option.isNone(source))
        return yield* new LoomForkSourceIdentityMissing({
          threadId: thread.id,
          sourceThreadId: author,
        });
      const record: LaunchIdentityRecord = {
        ...source.value,
        env: { ...source.value.env, [LOOM_QUERY_FORK_ENV]: "1" },
        replayedFrom: author,
      };
      // Written so the session-profile route serves the author's tools as this thread's.
      yield* writeLaunchIdentity(identityDir, thread.id, record);
      return record;
    }
    const own = yield* readLaunchIdentity(identityDir, thread.id);
    if (Option.isSome(own) && own.value.replayedFrom === undefined) return own.value;
    const firstLaunch = Option.isNone(own);
    const forkFrom = firstLaunch ? (workstream?.forkFromThreadId ?? null) : null;
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
    const record = Option.isSome(source)
      ? source.value
      : yield* composeIdentity(thread, workstream, projectRoot, longShare);
    yield* writeLaunchIdentity(identityDir, thread.id, record);
    return record;
  });

  const compose = Effect.fn("sessionComposerLive.compose")(
    function* (threadId: ThreadId) {
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
          ...loomHiddenToolsEnv(identity.tools),
          ...(retention === "long" && {
            PI_CACHE_WARMING_IDLE_MAX_MS: String(LOOM_CACHE_HORIZON_MS.long),
          }),
        },
        pathPrepend: gitShimDir,
        ...(retention === "long" && { idleTimeoutMs: LONG_ROOT_IDLE_TIMEOUT_MS }),
      } satisfies LoomOpenSessionFields;
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.provide(context),
        Effect.mapError((cause) => new LoomSessionComposerError({ threadId, cause })),
      ),
  );

  return { compose } satisfies LoomSessionComposerShape;
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
    ),
  ),
);
