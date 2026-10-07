/**
 * The production session composer (Phase 3a-5).
 *
 * The prompt, in reading order: the work-model addendum, the child-readership
 * clause (children only), the identity clause, the role overlay, the ship
 * policy, the role catalogue (only when the surface delegates), the goal
 * context, and — appended per launch, never recorded — the relocation clause.
 * Everything but the relocation clause is the thread's launch identity: written
 * once at its first compose and replayed verbatim by every later compose, and
 * by a `forkFrom` child's or a V2 fork's (thread_fork) first compose (P3-23).
 * Two drafter exceptions (DL-450): a `retro-reviewer` diverges in role from the thread it reviews, so
 * it composes its own identity with its server-owned overlay (V1's
 * `forkIdentity: "compose"`); a `handoff-drafter` replays its source when the
 * source has a record and composes fresh when it has none (an upstream-only
 * thread the human was chatting to). `env` carries `PI_CACHE_RETENTION` (DL-300).
 *
 * @module loom/prompt/sessionComposerLive
 */
import {
  type LoomThreadWorkstream,
  type OrchestrationV2AppThread,
  ThreadId,
} from "@t3tools/contracts";
import { resolveMergeAuthority, shipPolicyPromptBlock } from "@t3tools/shared/shipPolicy";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import {
  cacheRetentionForThread,
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
import * as LoomStore from "../projection/LoomStore.ts";
import {
  type LaunchIdentityRecord,
  readLaunchIdentity,
  writeLaunchIdentity,
} from "../workstream/launchIdentity.ts";
import { goalContextInstruction } from "./goalContext.ts";
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
  type LoomOpenSessionFields,
  type LoomSessionComposerShape,
} from "./sessionComposer.ts";

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

  /** The thread's identity from scratch: its role, ship policy, catalogue and goal as of now. */
  const composeIdentity = (
    thread: OrchestrationV2AppThread,
    workstream: LoomThreadWorkstream | null,
    projectRoot: string,
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
      const goal =
        workstream?.goalId == null ? null : yield* loomStore.goals.get(workstream.goalId);
      const appendSystemPrompt = [
        WORK_MODEL_ADDENDUM,
        isChild ? CHILD_READERSHIP_CLAUSE : undefined,
        threadIdentityClause(thread.id),
        overlay?.prompt,
        shipPolicyPromptBlock(resolveMergeAuthority(projectRoot)),
        catalogue.length > 0
          ? [
              "Available roles for spawning children (built in; a project may add its own under `.t3code/roles/`). A free-text role may still be used when none fits:",
              ...catalogue.map((role) => `- ${role.name}: ${role.summary}`),
            ].join("\n")
          : undefined,
        goal === null || goal.deletedAt !== null
          ? undefined
          : goalContextInstruction(goal, {
              asChildBackground: isChild,
              anchorTaskId: workstream?.anchorTaskId ?? null,
            }),
      ]
        .filter((part): part is string => part !== undefined && part.trim().length > 0)
        .join("\n\n");
      const { rootCacheRetention } = yield* settings.getSettings;
      return {
        appendSystemPrompt,
        skills: overlay?.skills ?? [],
        extensions: [extensionPath],
        env: {
          PI_CACHE_RETENTION: cacheRetentionForThread(thread.id, !isChild, rootCacheRetention),
        },
        modelSelection: thread.modelSelection,
        tools: overlay?.tools ?? [],
      } satisfies LaunchIdentityRecord;
    });

  /**
   * Own record → the fork source's record verbatim → a fresh composition; first one written.
   * The source is a `forkFrom` child's sibling, which must have a record, or a V2 fork's
   * lineage parent (thread_fork, a UI fork), which composes fresh as a root when it has none
   * (a V1-imported source never relaunched under V2).
   */
  const launchIdentity = (
    thread: OrchestrationV2AppThread,
    workstream: LoomThreadWorkstream | null,
    projectRoot: string,
  ) =>
    Effect.gen(function* () {
      const own = yield* readLaunchIdentity(identityDir, thread.id);
      if (Option.isSome(own)) return own.value;
      const forkFrom =
        workstream?.role === RETRO_REVIEWER_ROLE ? null : (workstream?.forkFromThreadId ?? null);
      const sourceThreadId =
        forkFrom ??
        (thread.lineage.relationshipToParent === "fork" ? thread.lineage.parentThreadId : null);
      const source =
        sourceThreadId === null
          ? Option.none<LaunchIdentityRecord>()
          : yield* readLaunchIdentity(identityDir, sourceThreadId);
      if (forkFrom !== null && Option.isNone(source) && workstream?.role !== HANDOFF_DRAFTER_ROLE)
        return yield* Effect.fail(
          new LoomForkSourceIdentityMissing({ threadId: thread.id, sourceThreadId: forkFrom }),
        );
      const record = Option.isSome(source)
        ? source.value
        : yield* composeIdentity(thread, workstream, projectRoot);
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
      const identity = yield* launchIdentity(
        thread,
        yield* loomStore.getWorkstream(threadId),
        cwd ?? process.cwd(),
      );
      const retention = identity.env.PI_CACHE_RETENTION;
      if (retention === "long" || retention === "short")
        yield* Effect.sync(() => recordCacheRetentionLaunch(config.stateDir, threadId, retention));
      // A session that ran in another directory remembers paths that are now historical.
      const relocated = cwd !== null && providerSessions.some((session) => session.cwd !== cwd);
      return {
        appendSystemPrompt: relocated
          ? `${identity.appendSystemPrompt}\n\n${relocationClause({ cwd })}`
          : identity.appendSystemPrompt,
        skills: identity.skills,
        extensions: identity.extensions,
        env: identity.env,
      } satisfies LoomOpenSessionFields;
    }).pipe(
      Effect.provide(context),
      Effect.mapError((cause) => new LoomSessionComposerError({ threadId, cause })),
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
