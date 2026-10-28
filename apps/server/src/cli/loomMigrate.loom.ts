// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off - an operator CLI: git, hashing, manifests and file copies are synchronous Node calls.
/**
 * `t3 loom-migrate export | import | verify` (plans/jacob-loom-account/plan.mdx §5). Ids never change;
 * import rewrites only paths and project ids, on known keys, and renumbers events in source order.
 * Rows are copied rather than replayed: goals, tasks and the usage ledger have no events behind them.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import type * as ServerConfig from "../config.ts";
import { rebuildThreadSearchIndex } from "../persistence/threadSearchIndex.loom.ts";
import {
  copyTables,
  ensureNotInUse,
  familyRootSql,
  PER_INSTANCE_TABLES,
  PROVIDER_SESSIONS_TABLE,
  readSliceSchema,
  type SliceSchema,
} from "../persistence/threadTreeSlice.loom.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class LoomMigrateError extends Schema.TaggedError<LoomMigrateError>()("LoomMigrateError", {
  message: Schema.String,
}) {}

type Config = ServerConfig.ServerConfig["Service"];
type Row = Record<string, unknown>;

interface ThreadMeasure {
  counts: Record<string, number>;
  events: number;
  maxSequence: number;
}
interface Measure {
  threads: Record<string, ThreadMeasure>;
  goals: Record<string, { events: number; maxSequence: number }>;
  tables: Record<string, number>;
}
interface ExportManifest extends Measure {
  exportedAt: string;
  source: { home: string; stateDir: string; dbPath: string };
  roots: Array<{ id: string; title: string }>;
  threadInfo: Record<
    string,
    { title: string; rootThreadId: string; worktreePath: string | null; branch: string | null }
  >;
  projects: Array<{ id: string; workspaceRoot: string }>;
  worktrees: Array<{
    path: string;
    threads: Array<string>;
    branch: string | null;
    statusBeforeExport: string;
    wipCommit: string | null;
  }>;
  /** `relative` is under the batch's `files/`; userdata files land at the same path under the destination state dir. */
  files: Array<{ kind: "userdata" | "session"; source: string; relative: string; sha256: string }>;
  /** pi session files, by the `nativeId` path rows hold and the cwd their header names. */
  sessions: Array<{ nativeId: string; cwd: string }>;
  missingSessions: Array<string>;
  bundles: Array<{ workspaceRoot: string; file: string; refs: Record<string, string> }>;
}
interface ImportManifest extends Measure {
  importedAt: string;
  home: string;
  dbPath: string;
  snapshot: string;
  pathMap: Array<[string, string]>;
  projectMap: Record<string, string>;
  files: Array<{ path: string; sha256: string }>;
  refs: Array<{ repo: string; ref: string; sha: string }>;
}

const fail = (message: string) => Effect.fail(new LoomMigrateError({ message }));
const attempt = <A>(what: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new LoomMigrateError({
        message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
const git = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
  attempt(`git ${args.join(" ")} (in ${cwd})`, () =>
    NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      input,
      maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
      // Reads never rewrite an index.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trimEnd(),
  );
const sha256 = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const readJson = <A>(file: string) =>
  attempt(`reading ${file}`, () => JSON.parse(NodeFS.readFileSync(file, "utf8")) as A);
const writeJson = (file: string, value: unknown) =>
  attempt(`writing ${file}`, () =>
    NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`),
  );
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const readableHash = (file: string) => {
  try {
    NodeFS.accessSync(file, NodeFS.constants.R_OK);
    return sha256(file);
  } catch {
    return null;
  }
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const fileStem = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
/** pi's session directory name for a cwd. */
const sessionDirName = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const roUrl = (file: string) => `${NodeURL.pathToFileURL(file).href}?mode=ro`;
const idList = (ids: Iterable<string>) =>
  `(SELECT value FROM json_each('${JSON.stringify([...ids]).replaceAll("'", "''")}'))`;

interface Selection {
  readonly threads: string;
  readonly goals: string;
}

/** Which rows of a table belong to the tree; `null`: the table never moves. */
const selectionWhere = (
  table: string,
  threadIdNullable: boolean | undefined,
  from: string,
  s: Selection,
): string | null => {
  switch (table) {
    case "orchestration_events":
      return `WHERE (aggregate_kind = 'thread' AND stream_id IN ${s.threads}) OR (aggregate_kind = 'goal' AND stream_id IN ${s.goals})`;
    // The re-drive pass skips a receipted `server:` command id, so receipts travel with their events.
    case "orchestration_command_receipts":
      return `WHERE (aggregate_kind = 'thread' AND aggregate_id IN ${s.threads}) OR (aggregate_kind = 'goal' AND aggregate_id IN ${s.goals})`;
    case "loom_goals":
    case "loom_goal_tasks":
      return `WHERE goal_id IN ${s.goals}`;
    case "loom_thread_consults":
      return `WHERE asker_thread_id IN ${s.threads} OR target_thread_id IN ${s.threads}`;
    case "loom_thread_peer_messages":
      return `WHERE sender_thread_id IN ${s.threads} OR target_thread_id IN ${s.threads}`;
    case "orchestration_v2_projection_context_transfers":
      return `WHERE source_thread_id IN ${s.threads} OR target_thread_id IN ${s.threads}`;
    case PROVIDER_SESSIONS_TABLE:
      return `WHERE thread_id IN ${s.threads} OR provider_session_id IN (SELECT provider_session_id FROM "${from}".orchestration_v2_projection_provider_session_bindings WHERE thread_id IN ${s.threads})`;
    // Derived (re-swept at boot) or retired.
    case "loom_thread_embeddings":
    case "orchestration_v2_events":
      return null;
    default:
      return threadIdNullable === undefined ? null : `WHERE thread_id IN ${s.threads}`;
  }
};

const NO_SELECTION: Selection = { threads: "()", goals: "()" };
const movedTables = (schema: SliceSchema) =>
  schema.tables
    .map((table) => table.name)
    .filter(
      (name) =>
        !schema.cleared.has(name) &&
        !schema.virtualTables.includes(name) &&
        selectionWhere(name, schema.threadIdNullable.get(name), "main", NO_SELECTION) !== null,
    );

/** Row counts of the tree in `main`: per thread and table, per goal, and per table. */
const measure = Effect.fn("loomMigrate.measure")(function* (
  schema: SliceSchema,
  threadIds: ReadonlyArray<string>,
  goalIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const s = { threads: idList(threadIds), goals: idList(goalIds) };
  const threads: Record<string, ThreadMeasure> = Object.fromEntries(
    threadIds.map((id) => [id, { counts: {}, events: 0, maxSequence: 0 }]),
  );
  const tables: Record<string, number> = {};
  for (const name of movedTables(schema)) {
    const where = selectionWhere(name, schema.threadIdNullable.get(name), "main", s);
    const [total] = yield* sql.unsafe<{ n: number }>(
      `SELECT count(*) AS n FROM main."${name}" ${where}`,
    );
    tables[name] = Number(total?.n ?? 0);
    if (!schema.threadIdNullable.has(name)) continue;
    const perThread = yield* sql.unsafe<{ thread_id: string; n: number }>(
      `SELECT thread_id, count(*) AS n FROM main."${name}" WHERE thread_id IN ${s.threads} GROUP BY thread_id`,
    );
    for (const row of perThread) threads[row.thread_id]!.counts[name] = Number(row.n);
  }
  const streams = (kind: "thread" | "goal") =>
    sql.unsafe<{ id: string; n: number; max: number }>(
      `SELECT stream_id AS id, count(*) AS n, max(sequence) AS max FROM main.orchestration_events
      WHERE aggregate_kind = '${kind}' AND stream_id IN ${kind === "thread" ? s.threads : s.goals}
      GROUP BY stream_id`,
    );
  for (const row of yield* streams("thread")) {
    Object.assign(threads[row.id]!, { events: Number(row.n), maxSequence: Number(row.max) });
  }
  const goals: Measure["goals"] = Object.fromEntries(
    goalIds.map((id) => [id, { events: 0, maxSequence: 0 }]),
  );
  for (const row of yield* streams("goal")) {
    goals[row.id] = { events: Number(row.n), maxSequence: Number(row.max) };
  }
  return { threads, goals, tables } satisfies Measure;
});

const countDiffs = (expected: Record<string, number>, actual: Record<string, number>) =>
  [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((key) => (expected[key] ?? 0) !== (actual[key] ?? 0))
    .map((key) => `${key} ${expected[key] ?? 0} → ${actual[key] ?? 0}`);

/** Threads (or goals) whose events moved since `recorded` was measured: someone used the copy. */
const changedSince = (recorded: Measure, now: Measure) => [
  ...Object.entries(recorded.threads)
    .filter(([id, was]) => {
      const is = now.threads[id];
      return is === undefined || is.events !== was.events || is.maxSequence !== was.maxSequence;
    })
    .map(([id]) => `thread ${id}`),
  ...Object.entries(recorded.goals)
    .filter(([id, was]) => {
      const is = now.goals[id];
      return is === undefined || is.events !== was.events || is.maxSequence !== was.maxSequence;
    })
    .map(([id]) => `goal ${id}`),
];

interface ThreadRow {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly rootThreadId: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

/** The requested roots' families, closed over goal-continue and fork links, read from `src`. */
const selectTree = Effect.fn("loomMigrate.selectTree")(function* (
  requested: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rootsOf = (ids: Iterable<string>) =>
    sql.unsafe<{ id: string; root: string }>(
      `SELECT t.thread_id AS id, ${familyRootSql("t")} AS root
      FROM src.orchestration_v2_projection_threads t WHERE t.thread_id IN ${idList(ids)}`,
    );
  const given = yield* rootsOf(requested);
  const unknown = requested.filter((id) => !given.some((row) => row.id === id));
  if (unknown.length > 0) return yield* fail(`No thread ${unknown.join(", ")} in the source.`);
  const roots = new Set(given.map((row) => row.root));
  for (;;) {
    const family = `(SELECT t.thread_id FROM src.orchestration_v2_projection_threads t WHERE ${familyRootSql("t")} IN ${idList(roots)})`;
    const linked = yield* sql.unsafe<{ id: string }>(
      `SELECT continues_thread_id AS id FROM src.loom_thread_workstream WHERE thread_id IN ${family}
      UNION SELECT fork_from_thread_id FROM src.loom_thread_workstream WHERE thread_id IN ${family}
      UNION SELECT thread_id FROM src.loom_thread_workstream
        WHERE continues_thread_id IN ${family} OR fork_from_thread_id IN ${family}`,
    );
    const more = (yield* rootsOf(linked.flatMap((row) => (row.id === null ? [] : [row.id]))))
      .map((row) => row.root)
      .filter((root) => !roots.has(root));
    if (more.length === 0) break;
    for (const root of more) roots.add(root);
  }
  const threads = yield* sql.unsafe<ThreadRow>(
    `SELECT t.thread_id AS id, t.title, t.project_id AS "projectId", ${familyRootSql("t")} AS "rootThreadId",
      json_extract(t.payload_json, '$.worktreePath') AS "worktreePath",
      json_extract(t.payload_json, '$.branch') AS branch
    FROM src.orchestration_v2_projection_threads t WHERE ${familyRootSql("t")} IN ${idList(roots)}`,
  );
  const ids = idList(threads.map((thread) => thread.id));
  const goals = yield* sql.unsafe<{ id: string; projectId: string }>(
    `SELECT goal_id AS id, project_id AS "projectId" FROM src.loom_goals WHERE goal_id IN (
      SELECT goal_id FROM src.loom_thread_workstream WHERE thread_id IN ${ids}
      UNION SELECT goal_id FROM src.projection_threads WHERE thread_id IN ${ids})`,
  );
  const projects = yield* sql.unsafe<{ id: string; workspaceRoot: string }>(
    `SELECT project_id AS id, workspace_root AS "workspaceRoot" FROM src.projection_projects
    WHERE project_id IN ${idList([...threads, ...goals].map((row) => row.projectId))}`,
  );
  return { roots: [...roots], threads, goals, projects };
});

/** What keeps a tree from being exported: anything still running or owed. */
const findBlockers = Effect.fn("loomMigrate.findBlockers")(function* (
  config: Config,
  threadIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const ids = idList(threadIds);
  const rows = yield* sql.unsafe<{ thread_id: string; what: string }>(
    `SELECT thread_id, 'a ' || status || ' run' AS what FROM src.orchestration_v2_projection_runs
      WHERE thread_id IN ${ids} AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
    UNION ALL SELECT thread_id, 'a ' || status || ' ' || kind || ' node' FROM src.orchestration_v2_projection_nodes
      WHERE thread_id IN ${ids} AND status IN ('idle', 'pending', 'running', 'waiting')
    UNION ALL SELECT thread_id, 'a pending ' || kind || ' request' FROM src.orchestration_v2_projection_runtime_requests
      WHERE thread_id IN ${ids} AND status = 'pending'
    UNION ALL SELECT thread_id, 'a ' || status || ' background ' || type FROM src.orchestration_v2_projection_turn_items
      WHERE thread_id IN ${ids} AND type IN ('command_execution', 'dynamic_tool', 'subagent')
        AND status IN ('pending', 'running', 'waiting')
    UNION ALL SELECT thread_id, 'pending background tasks' FROM src.orchestration_v2_projection_provider_threads
      WHERE thread_id IN ${ids} AND json_valid(payload_json)
        AND json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
    UNION ALL SELECT thread_id, 'a ' || status || ' ' || effect_type || ' effect' FROM src.orchestration_v2_effect_outbox
      WHERE thread_id IN ${ids} AND status IN ('pending', 'running')`,
  );
  const steering = threadIds
    .filter((id) =>
      NodeFS.existsSync(NodePath.join(config.stateDir, "pending-steering", `${id}.json`)),
    )
    .map((id) => ({ thread_id: id, what: "pending steering" }));
  return [...rows, ...steering].map((row) => `${row.thread_id}: ${row.what}`);
});

const GIT_OPERATION_MARKERS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];

/**
 * Commits each dirty worktree's changes on its thread branch (untracked files included, hooks
 * skipped), the one write the export makes in the source's repos. A project root is shared by
 * every thread that runs there, so uncommitted changes in one stop the export instead.
 */
const captureWorktrees = Effect.fn("loomMigrate.captureWorktrees")(function* (
  threads: ReadonlyArray<ThreadRow>,
  projectRoots: ReadonlySet<string>,
) {
  const byPath = new Map<string, Array<ThreadRow>>();
  for (const thread of threads) {
    if (thread.worktreePath === null) continue;
    byPath.set(thread.worktreePath, [...(byPath.get(thread.worktreePath) ?? []), thread]);
  }
  const worktrees: ExportManifest["worktrees"] = [];
  for (const [path, members] of byPath) {
    const ids = members.map((thread) => thread.id);
    const recorded = members.find((thread) => thread.branch !== null)?.branch ?? null;
    if (!NodeFS.existsSync(path)) {
      worktrees.push({
        path,
        threads: ids,
        branch: recorded,
        statusBeforeExport: "",
        wipCommit: null,
      });
      continue;
    }
    const status = yield* git(path, ["status", "--porcelain"]);
    if (projectRoots.has(path)) {
      if (status !== "")
        return yield* fail(
          `${path} is a project root with uncommitted changes, shared by every thread that runs there, so the export does not commit them. Commit or clear them, then re-run.\n${status}`,
        );
      worktrees.push({ path, threads: ids, branch: null, statusBeforeExport: "", wipCommit: null });
      continue;
    }
    for (const marker of GIT_OPERATION_MARKERS) {
      const markerPath = NodePath.resolve(
        path,
        yield* git(path, ["rev-parse", "--git-path", marker]),
      );
      if (NodeFS.existsSync(markerPath))
        return yield* fail(
          `${path} is mid-operation (${marker}); finish or abort it, then re-run.`,
        );
    }
    const head = yield* git(path, ["symbolic-ref", "--short", "-q", "HEAD"]).pipe(
      Effect.orElseSucceed(() => ""),
    );
    if (head === "" || (recorded !== null && head !== recorded))
      return yield* fail(
        `${path} has ${head === "" ? "a detached HEAD" : `'${head}' checked out`}, not the thread's branch${recorded === null ? "" : ` '${recorded}'`}; check it out there, then re-run.`,
      );
    let wipCommit: string | null = null;
    if (status !== "") {
      yield* git(path, ["add", "-A"]);
      yield* git(path, [
        "commit",
        "--no-verify",
        "-q",
        "-m",
        `loom-migrate WIP: ${ids.join(" ")} ${new Date().toISOString()}`,
      ]);
      wipCommit = yield* git(path, ["rev-parse", "HEAD"]);
    }
    worktrees.push({ path, threads: ids, branch: head, statusBeforeExport: status, wipCommit });
  }
  return worktrees;
});

/** Attachment ids a JSON value references: `attachments[].id` and any `attachmentId`. */
const collectAttachmentIds = (value: unknown, into: Set<string>, inAttachments = false): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentIds(item, into, inAttachments);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && (key === "attachmentId" || (inAttachments && key === "id")))
        into.add(item);
      else collectAttachmentIds(item, into, key === "attachments");
    }
  }
};

/** Reports, briefs and attachments under the state dir, and each pi session file, into `<out>/files`. */
const collectFiles = Effect.fn("loomMigrate.collectFiles")(function* (
  config: Config,
  threadIds: ReadonlyArray<string>,
  out: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const wanted = new Set<string>();
  const stems = threadIds.map(fileStem);
  for (const dir of ["workstream-reports", "workstream-briefs"]) {
    const full = NodePath.join(config.stateDir, dir);
    if (!NodeFS.existsSync(full)) continue;
    for (const name of NodeFS.readdirSync(full))
      if (stems.some((stem) => name.startsWith(`${stem}.`))) wanted.add(NodePath.join(full, name));
  }
  const recordedPaths = yield* sql<{ path: string | null }>`
    SELECT report_path AS path FROM main.loom_thread_workstream
    UNION SELECT kickoff_brief_path FROM main.loom_thread_workstream`;
  for (const { path } of recordedPaths)
    if (path !== null && NodePath.isAbsolute(path) && NodeFS.existsSync(path)) wanted.add(path);
  const attachmentIds = new Set<string>();
  const payloads = yield* sql<{ json: string }>`
    SELECT payload_json AS json FROM main.orchestration_v2_projection_messages
    UNION ALL SELECT payload_json FROM main.orchestration_v2_projection_turn_items
    UNION ALL SELECT attachments_json FROM main.projection_thread_messages WHERE attachments_json IS NOT NULL`;
  for (const { json } of payloads) collectAttachmentIds(parseJson(json), attachmentIds);
  for (const attachmentId of attachmentIds) {
    const file = resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId });
    if (file !== null) wanted.add(file);
  }
  const outside = [...wanted].filter(
    (file) => !file.startsWith(`${config.stateDir}${NodePath.sep}`),
  );
  if (outside.length > 0)
    return yield* fail(`Files outside ${config.stateDir} cannot be placed: ${outside.join(", ")}`);

  const files: ExportManifest["files"] = [];
  const copy = (kind: "userdata" | "session", source: string, relative: string) =>
    attempt(`copying ${source}`, () => {
      const target = NodePath.join(out, "files", relative);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.copyFileSync(source, target, NodeFS.constants.COPYFILE_EXCL);
      files.push({ kind, source, relative, sha256: sha256(target) });
    });
  for (const file of wanted)
    yield* copy(
      "userdata",
      file,
      NodePath.join("userdata", NodePath.relative(config.stateDir, file)),
    );

  const sessions: ExportManifest["sessions"] = [];
  const missingSessions: Array<string> = [];
  const nativeIds = yield* sql<{ nativeId: string }>`
    SELECT DISTINCT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS "nativeId"
    FROM main.orchestration_v2_projection_provider_threads
    WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL`;
  for (const { nativeId } of nativeIds) {
    if (!NodePath.isAbsolute(nativeId) || !NodeFS.existsSync(nativeId)) {
      missingSessions.push(nativeId);
      continue;
    }
    const header = yield* attempt(
      `reading the header of ${nativeId}`,
      () =>
        JSON.parse(NodeFS.readFileSync(nativeId, "utf8").split("\n", 1)[0]!) as { cwd?: unknown },
    );
    if (typeof header.cwd !== "string")
      return yield* fail(`${nativeId} has no cwd in its session header.`);
    sessions.push({ nativeId, cwd: header.cwd });
    yield* copy(
      "session",
      nativeId,
      NodePath.join(
        "sessions",
        NodePath.basename(NodePath.dirname(nativeId)),
        NodePath.basename(nativeId),
      ),
    );
  }
  return { files, sessions, missingSessions };
});

/** The key `CheckpointService` names a scope's checkpoint and baseline refs by. */
const scopeRefKey = (scopeId: string) =>
  Base64Url.encode(NodeCrypto.createHash("sha256").update(scopeId).digest("hex").slice(0, 32));

/** One bundle per project repo: the tree's checkpoint, baseline and review refs and its work branches. */
const bundleProjects = Effect.fn("loomMigrate.bundleProjects")(function* (
  projects: ReadonlyArray<{ id: string; workspaceRoot: string }>,
  threadIds: ReadonlyArray<string>,
  branches: ReadonlySet<string>,
  out: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const scopes = new Set(
    (yield* sql<{
      id: string;
    }>`SELECT scope_id AS id FROM main.orchestration_v2_projection_checkpoint_scopes`).map((row) =>
      scopeRefKey(row.id),
    ),
  );
  const reviewKeys = new Set(threadIds.map((id) => Base64Url.encode(id)));
  const keep = (ref: string) => {
    const [, , kind, key] = ref.split("/");
    if (ref.startsWith("refs/heads/")) return branches.has(ref.slice("refs/heads/".length));
    if (ref.startsWith("refs/t3/orchestration-v2/checkpoints/"))
      return scopes.has(ref.split("/")[4]!);
    if (kind === "loom-baseline") return scopes.has(key!);
    if (kind === "loom-review") return reviewKeys.has(key!);
    return false;
  };
  const bundles: ExportManifest["bundles"] = [];
  for (const project of projects) {
    if (!NodeFS.existsSync(project.workspaceRoot))
      return yield* fail(
        `Project root ${project.workspaceRoot} is gone, so its checkpoint refs cannot be read.`,
      );
    const listed = yield* git(project.workspaceRoot, [
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      "refs/t3/orchestration-v2/checkpoints",
      "refs/t3/loom-baseline",
      "refs/t3/loom-review",
      "refs/heads",
    ]);
    const refs = Object.fromEntries(
      listed
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split(" ") as [string, string])
        .filter(([, ref]) => keep(ref))
        .map(([sha, ref]) => [ref, sha]),
    );
    if (Object.keys(refs).length === 0) continue;
    const file = `git/${project.id}.bundle`;
    NodeFS.mkdirSync(NodePath.join(out, "git"), { recursive: true });
    yield* git(
      project.workspaceRoot,
      ["bundle", "create", "-q", NodePath.join(out, file), "--stdin"],
      `${Object.keys(refs).join("\n")}\n`,
    );
    bundles.push({ workspaceRoot: project.workspaceRoot, file, refs });
  }
  return bundles;
});

const withSource = Effect.fn("loomMigrate.withSource")(function* <A, E, R>(
  dbPath: string,
  filename: string,
  run: Effect.Effect<A, E, R>,
) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ATTACH DATABASE ${roUrl(dbPath)} AS src`;
    return yield* run;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
});

const printTree = (tree: Effect.Success<ReturnType<typeof selectTree>>) =>
  Console.log(
    [
      `${tree.threads.length} threads in ${tree.roots.length} trees, ${tree.goals.length} goals:`,
      ...tree.roots.map((root) => {
        const members = tree.threads.filter((thread) => thread.rootThreadId === root);
        return `  ${root}  ${members.find((thread) => thread.id === root)?.title ?? ""} (${members.length} threads)`;
      }),
      ...tree.projects.map((project) => `  project ${project.workspaceRoot}`),
    ].join("\n"),
  );

const runExport = Effect.fn("loomMigrate.export")(function* (input: {
  readonly config: Config;
  readonly roots: ReadonlyArray<string>;
  readonly out: string;
  readonly yes: boolean;
}) {
  const { config } = input;
  const out = NodePath.resolve(input.out);
  const slicePath = NodePath.join(out, "slice.sqlite");
  if (!NodeFS.existsSync(config.dbPath)) return yield* fail(`No database at ${config.dbPath}.`);
  if (input.roots.length === 0) return yield* fail("Name at least one --root.");
  if (!input.yes) {
    yield* withSource(
      config.dbPath,
      ":memory:",
      selectTree(input.roots).pipe(Effect.flatMap(printTree)),
    );
    return yield* Console.log(`Re-run with --yes to export into ${out}.`);
  }
  if (NodeFS.existsSync(NodePath.join(out, "manifest.json")) || NodeFS.existsSync(slicePath))
    return yield* fail(`${out} already holds an export; pick a fresh batch directory.`);
  yield* attempt(`creating ${out}`, () => NodeFS.mkdirSync(out, { recursive: true }));

  const manifest = yield* withSource(
    config.dbPath,
    slicePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const schema = yield* readSliceSchema("src", PER_INSTANCE_TABLES);
      // One read transaction: a turn that starts between the quiescence check and the copy is never half captured.
      const { tree, worktrees } = yield* sql.withTransaction(
        Effect.gen(function* () {
          const tree = yield* selectTree(input.roots);
          yield* printTree(tree);
          const threadIds = tree.threads.map((thread) => thread.id);
          const blockers = yield* findBlockers(config, threadIds);
          if (blockers.length > 0)
            return yield* fail(
              `Not quiesced; stop these in the UI first:\n${blockers.map((line) => `  ${line}`).join("\n")}`,
            );
          const worktrees = yield* captureWorktrees(
            tree.threads,
            new Set(tree.projects.map((project) => project.workspaceRoot)),
          );
          for (const table of schema.tables) yield* sql.unsafe(table.sql).unprepared;
          const selection = {
            threads: idList(threadIds),
            goals: idList(tree.goals.map((goal) => goal.id)),
          };
          yield* copyTables(schema, "src", (name, nullable) =>
            ["effect_sql_migrations", "loom_sql_migrations"].includes(name)
              ? ""
              : name === "projection_projects"
                ? `WHERE project_id IN ${idList(tree.projects.map((project) => project.id))}`
                : selectionWhere(name, nullable, "src", selection),
          );
          return { tree, worktrees };
        }),
      );
      const threadIds = tree.threads.map((thread) => thread.id);
      const files = yield* collectFiles(config, threadIds, out);
      const branches = new Set(
        worktrees.flatMap((worktree) => (worktree.branch === null ? [] : [worktree.branch])),
      );
      const bundles = yield* bundleProjects(tree.projects, threadIds, branches, out);
      const measured = yield* measure(
        yield* readSliceSchema("main", PER_INSTANCE_TABLES),
        threadIds,
        tree.goals.map((goal) => goal.id),
      );
      return {
        exportedAt: new Date().toISOString(),
        source: { home: config.baseDir, stateDir: config.stateDir, dbPath: config.dbPath },
        roots: tree.roots.map((id) => ({
          id,
          title: tree.threads.find((thread) => thread.id === id)?.title ?? "",
        })),
        threadInfo: Object.fromEntries(
          tree.threads.map(({ id, title, rootThreadId, worktreePath, branch }) => [
            id,
            { title, rootThreadId, worktreePath, branch },
          ]),
        ),
        projects: [...tree.projects],
        worktrees,
        ...files,
        bundles,
        ...measured,
      } satisfies ExportManifest;
    }),
  ).pipe(
    // A refused or failed export leaves no partial batch behind (its WIP commits stay on their branches).
    Effect.onError(() =>
      Effect.sync(() => {
        for (const name of ["slice.sqlite", "slice.sqlite-wal", "slice.sqlite-shm", "files", "git"])
          NodeFS.rmSync(NodePath.join(out, name), { recursive: true, force: true });
      }),
    ),
  );
  yield* writeJson(NodePath.join(out, "manifest.json"), manifest);
  for (const worktree of manifest.worktrees.filter((entry) => entry.wipCommit !== null))
    yield* Console.log(`  WIP ${worktree.wipCommit} on ${worktree.branch} (${worktree.path})`);
  for (const missing of manifest.missingSessions)
    yield* Console.log(`  warning: session file ${missing} is missing on this side too`);
  yield* Console.log(
    `Exported ${Object.keys(manifest.threads).length} threads, ${manifest.files.length} files and ${manifest.bundles.length} git bundles to ${out}.\nHand the directory to the importing user (chown -R), then run \`loom-migrate import\` there.`,
  );
});

/** `export --check`: has any exported thread moved on the source since? Then it must be exported again. */
const runCheck = Effect.fn("loomMigrate.check")(function* (config: Config, out: string) {
  const manifest = yield* readJson<ExportManifest>(
    NodePath.join(NodePath.resolve(out), "manifest.json"),
  );
  const rows = yield* withSource(
    config.dbPath,
    ":memory:",
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe<{ id: string; n: number; max: number }>(
        `SELECT stream_id AS id, count(*) AS n, max(sequence) AS max FROM src.orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id IN ${idList(Object.keys(manifest.threads))}
        GROUP BY stream_id`,
      ),
    ),
  );
  const moved = Object.entries(manifest.threads).flatMap(([id, exported]) => {
    const now = rows.find((row) => row.id === id);
    return now !== undefined &&
      Number(now.max) === exported.maxSequence &&
      Number(now.n) === exported.events
      ? []
      : [
          `  ${id}  ${manifest.threadInfo[id]?.title ?? ""}: sequence ${exported.maxSequence} → ${now?.max ?? "gone"}`,
        ];
  });
  if (moved.length > 0)
    return yield* fail(
      `Moved since export; export these trees again and bring them over with \`import --replace\`:\n${moved.join("\n")}`,
    );
  yield* Console.log(
    `Every exported thread is unchanged since export. Archive these roots on this instance:\n${manifest.roots
      .map((root) => `  ${root.id}  ${root.title}`)
      .join("\n")}`,
  );
});

const PATH_COLUMNS = new Set([
  "worktree_path",
  "report_path",
  "kickoff_brief_path",
  "session_path",
  "source_root",
  "git_common_dir",
]);
const PATH_KEYS = new Set([
  "worktreePath",
  "cwd",
  "reportPath",
  "kickoffBriefPath",
  "nativeId",
  "nativeThreadId",
]);

/**
 * The §5.3 remap, on known columns and JSON keys only. Turn items (tool calls and their output) and
 * message text keep their historical paths.
 */
const makeRemap = (input: {
  readonly pathMap: ReadonlyArray<readonly [string, string]>;
  readonly sessionMap: ReadonlyMap<string, string>;
  readonly projectMap: ReadonlyMap<string, string>;
}) => {
  const path = (value: string) => {
    const session = input.sessionMap.get(value);
    if (session !== undefined) return session;
    const hit = input.pathMap.find(([from]) => value === from || value.startsWith(`${from}/`));
    return hit === undefined ? value : `${hit[1]}${value.slice(hit[0].length)}`;
  };
  const json = (text: string) => {
    let changed = false;
    const swap = (target: object, key: PropertyKey, next: unknown) => {
      const record = target as Record<PropertyKey, unknown>;
      if (next === record[key]) return;
      record[key] = next;
      changed = true;
    };
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (typeof value === "string") {
          if (key === "projectId") swap(record, key, input.projectMap.get(value) ?? value);
          else if (PATH_KEYS.has(key)) swap(record, key, path(value));
        } else if (key === "documents" && Array.isArray(value)) {
          value.forEach((item, index) => {
            if (typeof item === "string") swap(value, index, path(item));
          });
        } else walk(value);
      }
    };
    try {
      const parsed: unknown = JSON.parse(text);
      walk(parsed);
      return changed ? JSON.stringify(parsed) : text;
    } catch {
      return text;
    }
  };
  return {
    path,
    row: (table: string, row: Row) => {
      const history =
        table === "orchestration_v2_projection_turn_items" ||
        (table === "orchestration_events" && row.event_type === "turn-item.updated");
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string") continue;
        if (column === "project_id") row[column] = input.projectMap.get(value) ?? value;
        else if (PATH_COLUMNS.has(column)) row[column] = path(value);
        else if (column.endsWith("_json") && !history) row[column] = json(value);
      }
      return row;
    },
  };
};

const pkColumns = (schemaName: string, table: string) =>
  table === "orchestration_events"
    ? Effect.succeed(["event_id"])
    : Effect.map(
        SqlClient.SqlClient,
        (sql) =>
          sql<{
            name: string;
          }>`SELECT name FROM pragma_table_info(${table}, ${schemaName}) WHERE pk > 0 ORDER BY pk`,
      ).pipe(
        Effect.flatten,
        Effect.map((rows) => rows.map((row) => row.name)),
      );

const latestAgentSequence = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{ n: number }>`SELECT COALESCE(MAX(sequence), 0) AS n FROM main.orchestration_events
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'`,
).pipe(Effect.map((rows) => Number(rows[0]?.n ?? 0)));

/** Keeps the projections current (no full replay at boot) when they were current before this write. */
const advanceProjectionSequence = Effect.fn("loomMigrate.advanceProjectionSequence")(function* (
  before: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE main.orchestration_v2_projection_metadata
    SET last_sequence = ${yield* latestAgentSequence}, updated_at = ${new Date().toISOString()}
    WHERE projection_name = 'thread-projections' AND last_sequence = ${before}`;
});

/** Deletes an earlier import of a tree, by the rows of its batch slice (attached as `alias`). */
const deleteImported = Effect.fn("loomMigrate.deleteImported")(function* (
  schema: SliceSchema,
  alias: string,
  threadIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const name of [...movedTables(schema), "loom_thread_embeddings"]) {
    if (!schema.tables.some((table) => table.name === name)) continue;
    if (schema.threadIdNullable.has(name))
      yield* sql.unsafe(`DELETE FROM main."${name}" WHERE thread_id IN ${idList(threadIds)}`);
    const pk = (yield* pkColumns(alias, name)).map((column) => `"${column}"`).join(", ");
    if (pk !== "" && name !== "loom_thread_embeddings")
      yield* sql.unsafe(
        `DELETE FROM main."${name}" WHERE (${pk}) IN (SELECT ${pk} FROM "${alias}"."${name}")`,
      );
  }
});

const snapshotDatabase = Effect.fn("loomMigrate.snapshot")(function* (file: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`VACUUM INTO ${file}`;
  const check = yield* Effect.flatMap(
    SqlClient.SqlClient,
    (snapshot) => snapshot<{ quick_check: string }>`PRAGMA quick_check`,
  ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: file, readonly: true })));
  if (check[0]?.quick_check !== "ok")
    return yield* fail(`The snapshot ${file} failed quick_check: ${JSON.stringify(check)}`);
  yield* Console.log(`Snapshot of the database before this write: ${file}`);
});

/** Refuses while a server holds the home, and keeps one from starting until this command exits. */
const holdHome = (config: Config) =>
  ensureNotInUse(config.dbPath).pipe(
    Effect.andThen(
      ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
        Effect.provide(ProcessRunner.layer),
      ),
    ),
  );

const INSERT_ORDER = ["orchestration_events", "loom_goals"];

const runImport = Effect.fn("loomMigrate.import")(function* (input: {
  readonly config: Config;
  readonly batch: string;
  readonly projects: Record<string, string>;
  readonly sessionsDir: string;
  readonly replace: string | undefined;
}) {
  const { config } = input;
  const batch = NodePath.resolve(input.batch);
  const manifest = yield* readJson<ExportManifest>(NodePath.join(batch, "manifest.json"));
  const recordPath = NodePath.join(batch, "import-manifest.json");
  if (NodeFS.existsSync(recordPath))
    return yield* fail(
      `${batch} was already imported (${recordPath}); verify it, or undo it with --rollback.`,
    );
  const previous =
    input.replace === undefined
      ? undefined
      : {
          dir: NodePath.resolve(input.replace),
          record: yield* readJson<ImportManifest>(
            NodePath.join(NodePath.resolve(input.replace), "import-manifest.json"),
          ),
        };
  const dropped = Object.keys(previous?.record.threads ?? {}).filter(
    (id) => !(id in manifest.threads),
  );
  if (dropped.length > 0)
    return yield* fail(
      `--replace would drop threads this batch does not carry: ${dropped.join(", ")}`,
    );
  if (!NodeFS.existsSync(config.dbPath))
    return yield* fail(`No database at ${config.dbPath}; start that home's server once first.`);
  yield* holdHome(config);

  const projectRoots = new Map(
    Object.entries(input.projects).map(([from, to]) => [
      NodePath.resolve(from),
      NodePath.resolve(to),
    ]),
  );
  const unmapped = manifest.projects.filter((project) => !projectRoots.has(project.workspaceRoot));
  if (unmapped.length > 0)
    return yield* fail(
      `Map every project with --project <source root>=<destination root>: ${unmapped.map((project) => project.workspaceRoot).join(", ")}`,
    );
  const pathMap = (
    [
      [manifest.source.stateDir, config.stateDir],
      [manifest.source.home, config.baseDir],
      ...manifest.projects.map((project) => [
        project.workspaceRoot,
        projectRoots.get(project.workspaceRoot)!,
      ]),
    ] as Array<[string, string]>
  ).toSorted(([a], [b]) => b.length - a.length);
  const prefixOnly = makeRemap({ pathMap, sessionMap: new Map(), projectMap: new Map() });
  const sessionMap = new Map(
    manifest.sessions.map((session) => [
      session.nativeId,
      NodePath.join(
        input.sessionsDir,
        sessionDirName(prefixOnly.path(session.cwd)),
        NodePath.basename(session.nativeId),
      ),
    ]),
  );
  const fileTargets = manifest.files.map((file) => ({
    ...file,
    from: NodePath.join(batch, "files", file.relative),
    to:
      file.kind === "session"
        ? sessionMap.get(file.source)!
        : NodePath.join(config.stateDir, NodePath.relative("userdata", file.relative)),
  }));
  const threadIds = Object.keys(manifest.threads);
  const goalIds = Object.keys(manifest.goals);

  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ATTACH DATABASE ${roUrl(NodePath.join(batch, "slice.sqlite"))} AS batch`;
    if (previous !== undefined)
      yield* sql`ATTACH DATABASE ${roUrl(NodePath.join(previous.dir, "slice.sqlite"))} AS prev`;
    const schema = yield* readSliceSchema("main", PER_INSTANCE_TABLES);

    // Guards: any failure stops here, before a write.
    for (const ledger of ["effect_sql_migrations", "loom_sql_migrations"]) {
      const differs = yield* sql.unsafe<{ n: number }>(
        `SELECT count(*) AS n FROM (
          SELECT migration_id, name FROM main."${ledger}" EXCEPT SELECT migration_id, name FROM batch."${ledger}"
          UNION ALL
          SELECT migration_id, name FROM batch."${ledger}" EXCEPT SELECT migration_id, name FROM main."${ledger}")`,
      );
      if (Number(differs[0]?.n ?? 0) > 0)
        return yield* fail(
          `${ledger} differs between the export and this database: run both instances on the same release.`,
        );
    }
    const projectMap = new Map<string, string>();
    for (const project of manifest.projects) {
      const root = projectRoots.get(project.workspaceRoot)!;
      const [row] = yield* sql<{ id: string }>`SELECT project_id AS id FROM main.projection_projects
        WHERE workspace_root = ${root} AND deleted_at IS NULL`;
      if (row === undefined)
        return yield* fail(
          `No live project at ${root} here; add it first (\`t3 project add ${root}\`).`,
        );
      projectMap.set(project.id, row.id);
    }
    const collisions: Array<string> = [];
    const replacedThreads = new Set(Object.keys(previous?.record.threads ?? {}));
    const presentThreads = (yield* sql<{
      id: string;
    }>`SELECT thread_id AS id FROM main.orchestration_v2_projection_threads
      WHERE thread_id IN (SELECT thread_id FROM batch.orchestration_v2_projection_threads)`).filter(
      (row) => !replacedThreads.has(row.id),
    );
    if (presentThreads.length > 0)
      collisions.push(
        `threads ${presentThreads.map((row) => row.id).join(", ")} (with --replace <earlier batch> if this is a re-export)`,
      );
    // Once whole threads collide, the per-table detail is noise.
    for (const name of presentThreads.length > 0 ? [] : movedTables(schema)) {
      const pk = yield* pkColumns("batch", name);
      if (pk.length === 0) continue;
      const same = (alias: string) =>
        pk.map((column) => `${alias}."${column}" = b."${column}"`).join(" AND ");
      const clash = yield* sql.unsafe<Row>(
        `SELECT ${pk.map((column) => `b."${column}"`).join(", ")} FROM batch."${name}" b
        WHERE EXISTS (SELECT 1 FROM main."${name}" m WHERE ${same("m")})
        ${previous === undefined ? "" : `AND NOT EXISTS (SELECT 1 FROM prev."${name}" p WHERE ${same("p")})`}
        LIMIT 3`,
      );
      if (clash.length > 0)
        collisions.push(`${name}: ${clash.map((row) => Object.values(row).join("/")).join(", ")}`);
    }
    const goals = yield* sql<{ goalId: string; projectId: string; slug: string }>`
      SELECT goal_id AS "goalId", project_id AS "projectId", slug FROM batch.loom_goals`;
    for (const goal of goals) {
      const taken =
        yield* sql`SELECT 1 FROM main.loom_goals WHERE project_id = ${projectMap.get(goal.projectId) ?? goal.projectId}
        AND slug = ${goal.slug} AND goal_id <> ${goal.goalId}`;
      if (taken.length > 0)
        collisions.push(`goal slug '${goal.slug}' is taken in its project here`);
    }
    const replacedFiles = new Set(previous?.record.files.map((file) => file.path));
    for (const file of fileTargets)
      if (NodeFS.existsSync(file.to) && !replacedFiles.has(file.to))
        collisions.push(`file ${file.to}`);
    const replacedRefs = new Set(previous?.record.refs.map((ref) => `${ref.repo} ${ref.ref}`));
    for (const bundle of manifest.bundles) {
      const repo = projectRoots.get(bundle.workspaceRoot)!;
      yield* git(repo, ["bundle", "verify", "-q", NodePath.join(batch, bundle.file)]);
      const present = new Set(
        (yield* git(repo, ["for-each-ref", "--format=%(refname)", "refs/t3", "refs/heads"])).split(
          "\n",
        ),
      );
      for (const ref of Object.keys(bundle.refs))
        if (present.has(ref) && !replacedRefs.has(`${repo} ${ref}`))
          collisions.push(`ref ${ref} in ${repo}`);
    }
    if (collisions.length > 0)
      return yield* fail(
        `Already present here, so nothing was written:\n${collisions.map((line) => `  ${line}`).join("\n")}`,
      );
    if (previous !== undefined) {
      const changed = changedSince(
        previous.record,
        yield* measure(
          schema,
          Object.keys(previous.record.threads),
          Object.keys(previous.record.goals),
        ),
      );
      if (changed.length > 0)
        return yield* fail(
          `The earlier import has been worked on here since, so the two copies diverged; nothing was written:\n  ${changed.join("\n  ")}`,
        );
    }

    const snapshot = NodePath.join(batch, `pre-import-${stamp()}.sqlite`);
    yield* snapshotDatabase(snapshot);

    // Every database write, in one transaction.
    const remap = makeRemap({ pathMap, sessionMap, projectMap });
    const before = yield* latestAgentSequence;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (previous !== undefined)
          yield* deleteImported(schema, "prev", Object.keys(previous.record.threads));
        const sequences: Array<[number, number]> = [];
        const mapSequence = (old: number) => {
          let low = 0;
          let high = sequences.length - 1;
          let hit = 0;
          while (low <= high) {
            const middle = (low + high) >> 1;
            if (sequences[middle]![0] <= old) {
              hit = sequences[middle]![1];
              low = middle + 1;
            } else high = middle - 1;
          }
          return hit;
        };
        const moved = movedTables(schema);
        // Events first (receipts and peer messages map onto their new sequences), goals before their tasks.
        const tables = [
          ...INSERT_ORDER.filter((name) => moved.includes(name)),
          ...moved.filter((name) => !INSERT_ORDER.includes(name)),
        ];
        for (const name of tables) {
          for (let after = 0; ;) {
            const page = yield* sql.unsafe<Row>(
              `SELECT rowid AS "__rowid", * FROM batch."${name}" WHERE rowid > ? ORDER BY rowid LIMIT 1000`,
              [after],
            );
            if (page.length === 0) break;
            after = Number(page.at(-1)!.__rowid);
            const rows = page.map(({ __rowid: _rowid, ...row }) => {
              const mapped = remap.row(name, row);
              if (name === "orchestration_command_receipts")
                mapped.result_sequence = mapSequence(Number(mapped.result_sequence));
              if (name === "loom_thread_peer_messages")
                mapped.seq = mapSequence(Number(mapped.seq));
              return mapped;
            });
            const width = Object.keys(rows[0]!).length;
            const size = Math.max(1, Math.min(500, Math.floor(30_000 / width)));
            for (let start = 0; start < rows.length; start += size) {
              const chunk = rows.slice(start, start + size);
              if (name !== "orchestration_events") {
                yield* sql`INSERT INTO main.${sql(name)} ${sql.insert(chunk as never)}`;
                continue;
              }
              // Source order, fresh sequence numbers.
              const oldSequence = new Map(
                chunk.map((row) => [row.event_id as string, Number(row.sequence)]),
              );
              const inserted = yield* sql<{ sequence: number; event_id: string }>`
                INSERT INTO main.orchestration_events ${sql.insert(chunk.map(({ sequence: _sequence, ...row }) => row) as never)}
                RETURNING sequence, event_id`;
              for (const row of inserted)
                sequences.push([oldSequence.get(row.event_id)!, Number(row.sequence)]);
              sequences.sort((a, b) => a[0] - b[0]);
            }
          }
        }
        yield* advanceProjectionSequence(before);
      }),
    );

    // Files and refs land after the commit; `verify` proves they all did.
    const record: ImportManifest = {
      importedAt: new Date().toISOString(),
      home: config.baseDir,
      dbPath: config.dbPath,
      snapshot,
      pathMap,
      projectMap: Object.fromEntries(projectMap),
      files: [],
      refs: [],
      ...(yield* measure(schema, threadIds, goalIds)),
    };
    yield* Effect.gen(function* () {
      for (const file of previous?.record.files ?? []) NodeFS.rmSync(file.path, { force: true });
      for (const ref of previous?.record.refs ?? [])
        yield* git(ref.repo, ["update-ref", "-d", ref.ref, ref.sha]).pipe(Effect.ignore);
      for (const file of fileTargets) {
        yield* attempt(`writing ${file.to}`, () => {
          NodeFS.mkdirSync(NodePath.dirname(file.to), { recursive: true });
          NodeFS.copyFileSync(file.from, file.to, NodeFS.constants.COPYFILE_EXCL);
          if (file.kind === "session") NodeFS.chmodSync(file.to, 0o600);
          record.files.push({ path: file.to, sha256: file.sha256 });
        });
      }
      for (const bundle of manifest.bundles) {
        const repo = projectRoots.get(bundle.workspaceRoot)!;
        yield* git(repo, [
          "fetch",
          "-q",
          "--no-tags",
          NodePath.join(batch, bundle.file),
          "refs/t3/*:refs/t3/*",
          "refs/heads/*:refs/heads/*",
        ]);
        for (const [ref, sha] of Object.entries(bundle.refs)) record.refs.push({ repo, ref, sha });
      }
      yield* rebuildThreadSearchIndex;
    }).pipe(Effect.ensuring(writeJson(recordPath, record).pipe(Effect.ignore)));
    yield* Console.log(
      `Imported ${threadIds.length} threads, ${record.files.length} files and ${record.refs.length} refs into ${config.baseDir}.\nRun \`loom-migrate verify --batch ${batch}\` before starting the server.`,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.dbPath })));
});

/** `import --rollback`: removes an import nobody has worked on since, rows, files and refs. */
const runRollback = Effect.fn("loomMigrate.rollback")(function* (config: Config, batchDir: string) {
  const batch = NodePath.resolve(batchDir);
  const recordPath = NodePath.join(batch, "import-manifest.json");
  const record = yield* readJson<ImportManifest>(recordPath);
  yield* holdHome(config);
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ATTACH DATABASE ${roUrl(NodePath.join(batch, "slice.sqlite"))} AS prev`;
    const schema = yield* readSliceSchema("main", PER_INSTANCE_TABLES);
    const changed = changedSince(
      record,
      yield* measure(schema, Object.keys(record.threads), Object.keys(record.goals)),
    );
    if (changed.length > 0)
      return yield* fail(
        `Worked on since the import, so a rollback would lose that work; restore ${record.snapshot} by hand if that is intended:\n  ${changed.join("\n  ")}`,
      );
    yield* snapshotDatabase(NodePath.join(batch, `pre-rollback-${stamp()}.sqlite`));
    const before = yield* latestAgentSequence;
    yield* sql.withTransaction(
      deleteImported(schema, "prev", Object.keys(record.threads)).pipe(
        Effect.andThen(advanceProjectionSequence(before)),
      ),
    );
    for (const file of record.files) {
      if (NodeFS.existsSync(file.path) && sha256(file.path) === file.sha256)
        NodeFS.rmSync(file.path);
      else yield* Console.log(`  kept ${file.path}: changed or gone since the import`);
    }
    for (const ref of record.refs)
      yield* git(ref.repo, ["update-ref", "-d", ref.ref, ref.sha]).pipe(
        Effect.catch(() => Console.log(`  kept ${ref.ref} in ${ref.repo}: moved since the import`)),
      );
    yield* rebuildThreadSearchIndex;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.dbPath })));
  NodeFS.renameSync(
    recordPath,
    NodePath.join(batch, `import-manifest.rolled-back-${stamp()}.json`),
  );
  yield* Console.log(
    `Rolled back ${Object.keys(record.threads).length} threads from ${config.baseDir}.`,
  );
});

const runVerify = Effect.fn("loomMigrate.verify")(function* (config: Config, batchDir: string) {
  const batch = NodePath.resolve(batchDir);
  const manifest = yield* readJson<ExportManifest>(NodePath.join(batch, "manifest.json"));
  const record = yield* readJson<ImportManifest>(NodePath.join(batch, "import-manifest.json"));
  const threadIds = Object.keys(manifest.threads);
  const problems = new Map<string, Array<string>>();
  const note = (key: string, problem: string) =>
    problems.set(key, [...(problems.get(key) ?? []), problem]);

  const { now, sessions } = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const schema = yield* readSliceSchema("main", PER_INSTANCE_TABLES);
    return {
      now: yield* measure(schema, threadIds, Object.keys(manifest.goals)),
      sessions: yield* sql.unsafe<{ id: string; nativeId: string }>(
        `SELECT thread_id AS id, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS "nativeId"
        FROM main.orchestration_v2_projection_provider_threads
        WHERE thread_id IN ${idList(threadIds)} AND json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL`,
      ),
    };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.dbPath, readonly: true })));

  for (const id of threadIds) {
    const exported = manifest.threads[id]!;
    const is = now.threads[id]!;
    for (const diff of countDiffs(exported.counts, is.counts)) note(id, diff);
    if (is.events !== exported.events) note(id, `events ${exported.events} → ${is.events}`);
  }
  for (const diff of countDiffs(manifest.tables, now.tables)) note("tables", diff);
  for (const [id, goal] of Object.entries(manifest.goals))
    if (now.goals[id]?.events !== goal.events)
      note("goals", `${id} events ${goal.events} → ${now.goals[id]?.events}`);
  for (const session of sessions)
    if (!NodeFS.existsSync(session.nativeId))
      note(session.id, `session file missing: ${session.nativeId}`);
  if (record.files.length !== manifest.files.length)
    note("files", `${manifest.files.length} exported, ${record.files.length} imported`);
  for (const file of record.files) {
    const hash = readableHash(file.path);
    if (hash !== file.sha256)
      note(
        "files",
        `${file.path} ${hash === null ? "missing or unreadable" : "differs from the export"}`,
      );
  }
  const exportedRefs = manifest.bundles.reduce(
    (n, bundle) => n + Object.keys(bundle.refs).length,
    0,
  );
  if (record.refs.length !== exportedRefs)
    note("refs", `${exportedRefs} exported, ${record.refs.length} imported`);
  for (const ref of record.refs) {
    const sha = yield* git(ref.repo, ["rev-parse", "-q", "--verify", ref.ref]).pipe(
      Effect.orElseSucceed(() => ""),
    );
    if (sha !== ref.sha)
      note(
        "refs",
        `${ref.ref} in ${ref.repo}: ${sha === "" ? "missing" : sha}, exported ${ref.sha}`,
      );
  }

  for (const id of threadIds)
    yield* Console.log(
      `${problems.has(id) ? "DIFF" : "ok  "}  ${id}  ${manifest.threadInfo[id]?.title ?? ""}${(problems.get(id) ?? []).map((p) => `\n      ${p}`).join("")}`,
    );
  for (const key of ["tables", "goals", "files", "refs"])
    for (const problem of problems.get(key) ?? []) yield* Console.log(`DIFF  ${key}: ${problem}`);
  if (problems.size > 0) return yield* fail(`Verification failed for ${batch}.`);
  yield* Console.log(
    `Verified ${threadIds.length} threads, ${record.files.length} files and ${record.refs.length} refs. Now start the server and ask one migrated thread per project "where were we?".`,
  );
});

const batchFlag = Flag.String("batch").pipe(
  Flag.withDescription("The batch directory an export wrote."),
);

const exportCommand = Command.make("export", {
  ...projectLocationFlags,
  root: Flag.String("root").pipe(
    Flag.atLeast(0),
    Flag.withDescription("A workstream root to move with its whole family (repeatable)."),
  ),
  out: Flag.String("out").pipe(Flag.withDescription("A fresh batch directory to write.")),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Export; without it, only list the trees."),
  ),
  check: Flag.Boolean("check").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Re-read the exported threads (in --out) and list the roots to archive, or what moved.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Export workstream trees (rows, files, pi sessions, checkpoint refs, uncommitted work) into a batch directory. The source database is only read.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      return yield* flags.check
        ? runCheck(config, flags.out)
        : runExport({ config, roots: flags.root, out: flags.out, yes: flags.yes });
    }),
  ),
);

const importCommand = Command.make("import", {
  ...projectLocationFlags,
  batch: batchFlag,
  project: Flag.KeyValuePair("project").pipe(
    Flag.optional,
    Flag.withDescription(
      "Map a source project root to this home's: <source root>=<root here> (repeatable).",
    ),
  ),
  sessionsDir: Flag.String("sessions-dir").pipe(
    Flag.optional,
    Flag.withDescription("pi's session directory (default ~/.pi/agent/sessions)."),
  ),
  replace: Flag.String("replace").pipe(
    Flag.optional,
    Flag.withDescription("An earlier batch of the same trees to replace, if unchanged here since."),
  ),
  rollback: Flag.Boolean("rollback").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Undo this batch's import (refused once it has been worked on)."),
  ),
}).pipe(
  Command.withDescription(
    "Import a batch into this home with its server stopped: snapshot first, one transaction, paths and project ids remapped.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      return yield* flags.rollback
        ? runRollback(config, flags.batch)
        : runImport({
            config,
            batch: flags.batch,
            projects: Option.getOrElse(flags.project, () => ({})),
            sessionsDir: NodePath.resolve(
              Option.getOrElse(flags.sessionsDir, () =>
                NodePath.join(NodeOS.homedir(), ".pi", "agent", "sessions"),
              ),
            ),
            replace: Option.getOrUndefined(flags.replace),
          });
    }).pipe(Effect.scoped),
  ),
);

const verifyCommand = Command.make("verify", { ...projectLocationFlags, batch: batchFlag }).pipe(
  Command.withDescription(
    "Prove an imported batch arrived whole: row counts, file hashes, refs, session files.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      return yield* runVerify(config, flags.batch);
    }),
  ),
);

export const loomMigrateCommand = Command.make("loom-migrate").pipe(
  Command.withDescription("Move workstream trees between Loom instances: export, import, verify."),
  Command.withSubcommands([exportCommand, importCommand, verifyCommand]),
);
