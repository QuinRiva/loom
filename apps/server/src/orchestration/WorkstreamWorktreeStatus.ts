// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import {
  CommandId,
  type OrchestrationCommand,
  type WorkstreamRemoveWorktreeResult,
  type WorkstreamWorktreeEntry,
  type WorkstreamWorktreesResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { WorktreeReaper } from "./Services/WorktreeReaper.ts";
import { performWorktreeRemoval } from "./worktreeRemoval.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorktreeMutationLock } from "../git/WorktreeMutationLock.ts";
import { WorkspaceLease } from "../workspace/WorkspaceLease.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

/**
 * Workstream worktrees maintenance surface (phase 3): the on-demand scan the
 * Settings → Worktrees page reads, plus the guarded, human-confirmed removal
 * it commands. The classification truth comes from the Wave-1 reaper
 * (`WorktreeReaper.classifyWorktrees`); this layer only enriches it with
 * project/owner labels and `du` disk sizing, and re-classifies before removing.
 */
export class WorkstreamWorktreeStatus extends Context.Service<
  WorkstreamWorktreeStatus,
  {
    readonly read: Effect.Effect<WorkstreamWorktreesResult>;
    readonly remove: (input: {
      readonly worktreePath: string;
      readonly acknowledgeDirty: boolean;
      readonly acknowledgeUnmerged: boolean;
    }) => Effect.Effect<WorkstreamRemoveWorktreeResult>;
  }
>()("t3/orchestration/WorkstreamWorktreeStatus") {}

// Sizing is best-effort UI enrichment layered on top of the (now-parallel)
// classification. `du` is disk-IO-throughput-bound: concurrency 16 collapses a
// 40-worktree host from ~40s (was conc 6) to ~6-7s, and raising it further only
// adds contention. Past that point the wall clock is real `du` work, not the
// per-item timeout, so the timeout is now just a safety cap on a pathologically
// stuck tree — kept generous (5s, halved from 10s) so genuinely large trees
// still report a size instead of needlessly degrading to `—`, while staying well
// under the 15s slow-request toast. Each cell degrades independently on
// timeout/win32; the scan never fails.
const DU_CONCURRENCY = 16;
const DU_TIMEOUT_MS = 5_000;
const DU_MAX_OUTPUT_BYTES = 64 * 1024;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const reaper = yield* WorktreeReaper;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const gitWorkflow = yield* GitWorkflowService;
  const worktreeMutationLock = yield* WorktreeMutationLock;
  const workspaceLease = yield* WorkspaceLease;
  const removalDeps = Layer.mergeAll(
    Layer.succeed(GitWorkflowService, gitWorkflow),
    Layer.succeed(WorktreeMutationLock, worktreeMutationLock),
    Layer.succeed(WorkspaceLease, workspaceLease),
  );

  // `du -sk <path>` → resident KiB. Best-effort: a timeout or non-POSIX host
  // degrades one cell (null) rather than failing the whole scan.
  const sizeBytesOf = (path: string): Effect.Effect<number | null> =>
    platform === "win32"
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          const child = yield* spawner.spawn(ChildProcess.make("du", ["-sk", path]));
          const [stdout, exitCode] = yield* Effect.all(
            [
              collectUint8StreamText({ stream: child.stdout, maxBytes: DU_MAX_OUTPUT_BYTES }),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (exitCode !== 0) return null;
          const kib = Number.parseInt(stdout.text.trim().split(/\s+/)[0] ?? "", 10);
          return Number.isFinite(kib) && kib >= 0 ? kib * 1024 : null;
        }).pipe(
          Effect.scoped,
          Effect.timeoutOption(Duration.millis(DU_TIMEOUT_MS)),
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        );

  // Fall back to the directory mtime when there is no owning thread to date.
  const mtimeAgeMs = (path: string, nowMs: number): Effect.Effect<number | null> =>
    Effect.tryPromise(() => NodeFSP.stat(path)).pipe(
      // Floor: `ageMs` is a NonNegativeInt on the wire and mtimeMs is fractional.
      Effect.map((s) => Math.max(0, Math.floor(nowMs - s.mtimeMs))),
      Effect.orElseSucceed(() => null),
    );

  const read: WorkstreamWorktreeStatus["Service"]["read"] = Effect.gen(function* () {
    const readAt = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(readAt);
    const classified = yield* reaper.classifyWorktrees().pipe(Effect.orElseSucceed(() => []));
    const snapshot = yield* snapshotQuery.getShellSnapshot().pipe(Effect.orElseSucceed(() => null));
    const projectsById = new Map((snapshot?.projects ?? []).map((p) => [p.id, p]));
    const rolesById = new Map((snapshot?.threads ?? []).map((t) => [t.id, t.role]));

    const entries = yield* Effect.forEach(
      classified,
      (entry) =>
        Effect.gen(function* () {
          const sizeBytes = yield* sizeBytesOf(entry.path);
          const ageMs = entry.ageMs ?? (yield* mtimeAgeMs(entry.path, nowMs));
          return {
            worktreePath: entry.path,
            projectName: projectsById.get(entry.projectId)?.title ?? entry.projectId,
            branch: entry.branch,
            isMain: entry.isMain,
            disposition: entry.disposition,
            reason: entry.staleReason,
            owner:
              entry.threadId !== null && entry.threadTitle !== null
                ? {
                    threadId: entry.threadId,
                    title: entry.threadTitle,
                    role: rolesById.get(entry.threadId) ?? null,
                  }
                : null,
            ageMs,
            merged: entry.mergedIntoParentBranch,
            dirty: entry.dirty !== false,
            sizeBytes,
          } satisfies WorkstreamWorktreeEntry;
        }),
      { concurrency: DU_CONCURRENCY },
    );

    return { readAt, entries };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("workstream worktrees scan failed", { cause }).pipe(
        Effect.andThen(DateTime.now),
        Effect.map((readAt) => ({ readAt, entries: [] })),
      ),
    ),
  );

  const refuse = (message: string): WorkstreamRemoveWorktreeResult => ({
    removed: false,
    deletedBranch: null,
    message,
  });

  const remove: WorkstreamWorktreeStatus["Service"]["remove"] = (input) =>
    Effect.gen(function* () {
      // Re-classify before acting (TOCTOU): the guardrails are server-enforced
      // against the live state, never trusted from a possibly-stale snapshot.
      const classified = yield* reaper.classifyWorktrees().pipe(Effect.orElseSucceed(() => []));
      const entry = classified.find((c) => c.path === input.worktreePath);
      if (entry === undefined) {
        return refuse("This worktree no longer exists. Refresh the list.");
      }
      if (entry.disposition === "active") {
        return refuse("This worktree is in use by a live thread or a pending fan-in.");
      }
      const dirty = entry.dirty !== false;
      const unmerged = entry.mergedIntoParentBranch !== true;
      if (dirty && !input.acknowledgeDirty) {
        return refuse("This worktree has uncommitted changes. Confirm deletion to remove it.");
      }
      if (unmerged && !input.acknowledgeUnmerged) {
        return refuse(
          "This worktree's branch is not merged. Confirm to remove the checkout — the branch is kept.",
        );
      }

      const snapshot = yield* snapshotQuery
        .getShellSnapshot()
        .pipe(Effect.orElseSucceed(() => null));
      const cwd =
        entry.parentCwd ??
        snapshot?.projects.find((p) => p.id === entry.projectId)?.workspaceRoot ??
        null;
      if (cwd === null) {
        return refuse("Could not resolve the repository for this worktree.");
      }

      // `performWorktreeRemoval` gates on the same lease every automated remover
      // passes through (plan §7). The dirty/unmerged acknowledgements above are
      // about *commits*; no human can meaningfully acknowledge "a provider
      // process is writing in here right now". The classification already labels
      // a held tree `active`, but that is a snapshot — this is the atomic guard.
      const removal = yield* performWorktreeRemoval({
        cwd,
        path: entry.path,
        branch: entry.branch,
        forceWorktree: dirty,
        deleteBranchWhenMerged: !unmerged,
      }).pipe(Effect.provide(removalDeps));
      if (Option.isNone(removal)) {
        return refuse("A provider process is running in this worktree. Stop the thread first.");
      }
      const { deletedBranch } = removal.value;

      if (entry.threadId !== null) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(`server:worktree-panel:meta:${yield* crypto.randomUUIDv4}`),
            threadId: entry.threadId,
            worktreePath: null,
          } satisfies OrchestrationCommand)
          .pipe(Effect.ignoreCause({ log: true }));
      }

      return {
        removed: true,
        deletedBranch,
        message: null,
      } satisfies WorkstreamRemoveWorktreeResult;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("workstream worktree removal failed", {
          worktreePath: input.worktreePath,
          cause,
        }).pipe(Effect.as(refuse("Removal failed. See server logs for details."))),
      ),
    );

  return WorkstreamWorktreeStatus.of({ read, remove });
});

export const layer = Layer.effect(WorkstreamWorktreeStatus, make);
