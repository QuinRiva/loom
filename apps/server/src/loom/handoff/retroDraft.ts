// @effect-diagnostics nodeBuiltinImport:off
/**
 * `/retro`: a FRESH, visible `retro-reviewer` root over the source thread's whole
 * workstream — no fork, so it starts at once even when the source is mid-turn and
 * carries none of the source's transcript. Before the spawn the server claims a
 * run directory under `~/loom-retro/runs/` and writes `manifest.json` there: every
 * thread in the source's root tree (grandchildren and archived included) with its
 * report and pi session paths, which the retro skill's scanner reads. The kickoff
 * (a brief on disk, `kickoffBriefPath`) names the run directory, the skill and a
 * one-line-per-thread listing; the reviewer reaches the threads themselves with
 * `consult_thread`, which is global. The reviewer has no goal (`deriveEmergentGoal`
 * skips the role) and no parent: the human reads it directly.
 *
 * @module loom/handoff/retroDraft
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  LOOM_WS_METHODS,
  LoomWsMethodError,
  type OrchestrationV2ThreadShell,
  ThreadId,
  type WorkOutcomeCounts,
} from "@t3tools/contracts";
import { slugify } from "@t3tools/shared/String";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  type WorkstreamTreeThread,
  workstreamTreeView,
} from "../../mcp/toolkits/workstream/handlers/list.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { controlMessage } from "../orchestration/dispatcher/controlMessage.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import { LOOM_REPO_ROOT } from "../prompt/roleOverlay.ts";
import { writeWorkstreamBrief } from "../workstream/brief.ts";
import { curatedTitle } from "./handoffDraft.ts";

/** The role every retro-reviewer special case keys on (the composer's server-owned overlay). */
export const RETRO_REVIEWER_ROLE = "retro-reviewer";

/** Where each retro's run directory (manifest, digest, recap) is claimed. */
export const RETRO_RUNS_DIR = NodePath.join(NodeOS.homedir(), "loom-retro", "runs");

/** The retro skill in the running server's own checkout (a dev worktree, or the release). */
export const RETRO_SKILL_PATH = NodePath.join(LOOM_REPO_ROOT, "skills", "retro", "SKILL.md");

/**
 * The retro reviewer's role overlay, SERVER-OWNED: the reviewer is minted by the
 * server, never spawned from the role catalogue, so its policy is this constant
 * rather than a role file. The session composer supplies it for the role.
 * Placeholder wording: model-read text, to be rewritten by its author.
 */
export const RETRO_REVIEWER_OVERLAY_PROMPT = `You are a retrospective reviewer in a fresh thread. You did not do the work under review and do not carry its transcript: your kickoff names the source workstream, its run directory (with \`manifest.json\` listing every thread, its report and its session file) and the retro skill.

- Read the retro skill first and follow it. Scan the source tree's session files with its scanner before reading reports or consulting any thread.
- You are report-only: change nothing about the work under review — no code edits, no commits, no workstream or goal/task-tree mutations.
- Write only under your run directory and \`~/loom-retro/\`.
- There is no parent orchestrator: the human reads you directly. End your turn naming your recap's path for the human to triage.`;

/** The reviewer's title, `Retro: <source title>`. */
export const buildRetroTitle = (sourceTitle: string) => curatedTitle("Retro", sourceTitle);

export interface RetroManifestThread {
  readonly id: ThreadId;
  readonly parentId: ThreadId | null;
  readonly role: string | null;
  readonly title: string;
  readonly purpose: string | null;
  readonly model: string | null;
  readonly outcome: string | null;
  /** The sidecar's `last_outcome`: the routing verdict of the latest submit. */
  readonly lastDecision: {
    readonly outcome: string;
    readonly decision: string;
    readonly round: number;
    readonly counts: WorkOutcomeCounts | null;
  } | null;
  /** Attention flags ever raised on the thread (from its event history). */
  readonly attentionEpisodes: number;
  readonly gateRounds: number;
  readonly kickoffAt: string | null;
  readonly outcomeAt: string | null;
  readonly reportPath: string | null;
  readonly sessionPath: string | null;
  readonly reportSynthesised: boolean;
}

/** `manifest.json` in the run directory: what the retro skill's scanner reads. */
export interface RetroManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly focus: string;
  readonly runDir: string;
  readonly source: {
    readonly threadId: ThreadId;
    readonly rootThreadId: ThreadId;
    readonly title: string;
    readonly goalTitle: string | null;
  };
  readonly threads: ReadonlyArray<RetroManifestThread>;
}

/** One manifest entry from a tree-view thread, its session path and its raised-flag count. */
export const retroManifestThread = (
  thread: WorkstreamTreeThread,
  sessionPath: string | null,
  attentionEpisodes: number,
): RetroManifestThread => {
  const ws = thread.workstream;
  const last = ws.lastOutcome;
  return {
    id: thread.id,
    parentId: ws.parentThreadId,
    role: ws.role,
    title: thread.title,
    purpose: ws.purpose,
    model: thread.modelSelection.model,
    outcome: ws.outcome,
    lastDecision:
      last === null
        ? null
        : {
            outcome: last.outcome,
            decision: last.decision,
            round: last.round,
            counts: last.counts ?? null,
          },
    attentionEpisodes,
    gateRounds: ws.gateRounds,
    kickoffAt: ws.kickoffAt,
    outcomeAt: ws.outcomeAt,
    reportPath: ws.reportPath,
    sessionPath,
    reportSynthesised: last?.synthesised === true,
  };
};

/**
 * The retro kickoff: identity, focus, the source, the run directory, the skill and
 * the tree as one line per thread. Placeholder wording: model-read text, to be
 * rewritten by its author.
 */
export const buildRetroKickoffPrompt = (manifest: RetroManifest, skillPath: string) => {
  const { source } = manifest;
  const root = manifest.threads.find((thread) => thread.id === source.rootThreadId);
  return [
    `You are a retrospective reviewer, started fresh by the human's \`/retro\`. Review how the source workstream's development process went.`,
    "",
    `- Focus: ${manifest.focus}`,
    `- Source thread: ${source.threadId} "${source.title}"`,
    `- Source root: ${source.rootThreadId} "${root?.title ?? source.title}"; goal: ${source.goalTitle === null ? "none" : `"${source.goalTitle}"`}`,
    `- Run directory: \`${manifest.runDir}\` — \`manifest.json\` there lists every thread below with its report and session file.`,
    `- Retro skill: \`${skillPath}\` — read it first and follow it.`,
    "",
    `Threads (${manifest.threads.length}; id, parent, role, title, outcome):`,
    ...manifest.threads.map(
      (thread) =>
        `- ${thread.id} parent=${thread.parentId ?? "none"} [${thread.role ?? "thread"}] "${thread.title}" outcome=${thread.outcome ?? "open"}`,
    ),
  ].join("\n");
};

const method = LOOM_WS_METHODS.retroDraft;
const fail = (message: string) => new LoomWsMethodError({ method, message });

/** Claims `<runsDir>/<date>-<slug>` (then `-2`, `-3`, …): creating the directory is the claim. */
const claimRunDir = (runsDir: string, base: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(runsDir, { recursive: true });
    for (let attempt = 1; ; attempt++) {
      const dir = NodePath.join(runsDir, attempt === 1 ? base : `${base}-${attempt}`);
      const claimed = yield* fileSystem.makeDirectory(dir).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      );
      if (claimed) return dir;
    }
  });

/** The reviewer's spawn (a goal-less root on the source's worktree, branch and model) and its kickoff. */
const buildRetroCommands = (input: {
  readonly source: OrchestrationV2ThreadShell;
  readonly reviewerThreadId: ThreadId;
  readonly focus: string;
  readonly kickoffBriefPath: string;
  readonly kickoff: string;
  readonly createdAt: string;
}) => {
  const { source } = input;
  const id = (step: string) => `server:loom:retro:${input.reviewerThreadId}:${step}`;
  return [
    {
      type: "thread.spawn",
      commandId: CommandId.make(id("spawn")),
      threadId: input.reviewerThreadId,
      createdAt: input.createdAt,
      // The human asked for it (the composer intercept); the server builds it.
      createdBy: "user",
      creationSource: "server",
      parentThreadId: null,
      projectId: source.projectId,
      title: buildRetroTitle(source.title),
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      branch: source.branch,
      worktreePath: source.worktreePath,
      role: RETRO_REVIEWER_ROLE,
      purpose: `Retro of thread ${source.id}; focus: ${input.focus}`,
      goalId: null,
      kickoffBriefPath: input.kickoffBriefPath,
    },
    controlMessage({
      threadId: input.reviewerThreadId,
      id: id("kickoff"),
      tier: "steered",
      origin: "kickoff",
      text: input.kickoff,
    }),
  ] as const;
};

/**
 * Validates the source (it exists and has a pi session), writes the run directory's
 * manifest, and spawns and kicks off the reviewer; returns the reviewer's id.
 * Fails with `LoomWsMethodError` naming `loom.retroDraft`.
 */
export const launchRetro = (input: {
  readonly sourceThreadId: ThreadId;
  readonly focus: string | undefined;
  /** `RETRO_RUNS_DIR` in production; a test seam. */
  readonly runsDir: string;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const store = yield* LoomStoreV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* orchestrator.getThreadShell(input.sourceThreadId);
    if (source === null || source.deletedAt != null)
      return yield* fail("The source thread was not found.");
    const { providerThreads } = yield* orchestrator.getThreadRecords(source.id, [
      "providerThreads",
    ]);
    if (!providerThreads.some((thread) => thread.driver === "pi"))
      return yield* fail("Only a thread with a pi session can be reviewed.");

    const tree = yield* workstreamTreeView(source);
    const root = tree.threads.find((thread) => thread.id === tree.rootThreadId) ?? source;
    // Depth-first from the root, so the listing reads as the tree.
    const ids = new Set(tree.threads.map((thread) => thread.id));
    const byParent = Map.groupBy(tree.threads, ({ workstream }) =>
      workstream.parentThreadId !== null && ids.has(workstream.parentThreadId)
        ? workstream.parentThreadId
        : null,
    );
    const subtree = (parent: ThreadId | null): ReadonlyArray<WorkstreamTreeThread> =>
      (byParent.get(parent) ?? []).flatMap((thread) => [thread, ...subtree(thread.id)]);
    const threads = subtree(null);
    const goalId = source.workstream?.goalId ?? root.workstream?.goalId ?? null;
    const goal = goalId === null ? null : yield* store.goals.get(goalId);
    const attentionEpisodes = yield* Effect.forEach(
      threads,
      (thread) =>
        Effect.map(
          store.history(thread.id),
          (entries) => entries.filter((entry) => entry.type === "attention-raised").length,
        ),
      { concurrency: 8 },
    );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const runDir = yield* claimRunDir(
      input.runsDir,
      `${createdAt.slice(0, 10)}-${slugify(root.title, "retro")}`,
    );
    const focus = input.focus ?? "general";
    const manifest: RetroManifest = {
      version: 1,
      createdAt,
      focus,
      runDir,
      source: {
        threadId: source.id,
        rootThreadId: tree.rootThreadId,
        title: source.title,
        goalTitle: goal?.title ?? null,
      },
      threads: threads.map((thread, index) =>
        retroManifestThread(
          thread,
          tree.sessionPaths.get(thread.id) ?? null,
          attentionEpisodes[index]!,
        ),
      ),
    };
    yield* fileSystem.writeFileString(
      NodePath.join(runDir, "manifest.json"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off -- a plain record, pretty-printed for the scanner and a human.
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const reviewerThreadId = ThreadId.make(yield* (yield* Crypto.Crypto).randomUUIDv4);
    const kickoff = buildRetroKickoffPrompt(manifest, RETRO_SKILL_PATH);
    for (const command of buildRetroCommands({
      source,
      reviewerThreadId,
      focus,
      kickoffBriefPath: yield* writeWorkstreamBrief(reviewerThreadId, kickoff),
      kickoff,
      createdAt,
    }))
      yield* orchestrator.dispatch(command);
    return reviewerThreadId;
  }).pipe(
    Effect.catchIf(
      (error) => error._tag !== "LoomWsMethodError",
      (cause) =>
        Effect.fail(
          new LoomWsMethodError({ method, message: `${method} failed to start the retro.`, cause }),
        ),
    ),
  );
