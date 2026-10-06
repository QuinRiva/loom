// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off - a hand-built V1 fixture on disk, read back as raw JSON columns.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type LoomThreadWorkstream,
  PI_DEFAULT_MODEL,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { isEligibleToStart, type StartNode } from "@t3tools/shared/workstreamStart.loom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import { deriveProviderThread } from "../../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { shouldPrepareLegacyImportHandoff } from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { reconcileMigrationLedgers, runLoomMigrations } from "../../persistence/LoomMigrations.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { readWorkstream } from "../projection/LoomStore.ts";
import * as LoomV1WorkstreamImporter from "./LoomV1WorkstreamImporter.ts";

it("skips the legacy-import handoff for a thread bound to its native session (D8)", () => {
  const input = {
    historyOrigin: "v1_import",
    hasCompletedRun: false,
    legacyImportItemCount: 3,
  } as const;
  assert.isTrue(shouldPrepareLegacyImportHandoff({ ...input, hasStrongNativeRef: false }));
  assert.isTrue(shouldPrepareLegacyImportHandoff(input));
  assert.isFalse(shouldPrepareLegacyImportHandoff({ ...input, hasStrongNativeRef: true }));
});

// ---------------------------------------------------------------------------
// The fixture: one V1 `state.sqlite` (upstream lane 054, Loom lane 1045) whose
// rows cover every lane × root/child and the plan's edge rows (gate g-fixture).
// ---------------------------------------------------------------------------

const PROJECT = "project-1";
const GOAL = "goal-1";
const TASK = "task-1";
const T0 = Date.parse("2026-08-01T00:00:00.000Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const PI_JSON = '{"instanceId":"pi","model":"cliproxy/claude-opus-5-5"}';

interface Fixture {
  readonly id: string;
  readonly parent?: string;
  readonly lane: string;
  readonly goal?: string;
  readonly anchor?: string;
  readonly role?: string;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly laneSince?: string | null;
  readonly turns?: boolean;
  readonly userMessage?: boolean;
  readonly brief?: string;
  readonly briefPath?: "existing" | "missing";
  readonly blockedBy?: ReadonlyArray<string>;
  readonly attention?: ReadonlyArray<string>;
  readonly routes?: ReadonlyArray<object>;
  readonly graphKey?: string;
  readonly lastOutcome?: object;
  readonly report?: boolean;
  readonly modelJson?: string | null;
  readonly session?: "valid" | "corrupt";
}

const R = "root-orchestrator";
const FIXTURES: ReadonlyArray<Fixture> = [
  // A goal_handoff-born root: `planned` with turns (fact 3) — not held, kickoff set.
  {
    id: R,
    lane: "planned",
    goal: GOAL,
    anchor: TASK,
    role: "orchestrator",
    turns: true,
    session: "valid",
  },
  // Children, one per lane.
  { id: "c-planned-new", parent: R, lane: "planned", role: "coder", briefPath: "existing" },
  // Started by a user message alone; V1's legacy model shape upstream cannot decode.
  {
    id: "c-planned-started",
    parent: R,
    lane: "planned",
    role: "coder",
    userMessage: true,
    modelJson: '{"instanceId":"pi","model":"cliproxy/claude-fable-5-1","options":"high"}',
    session: "valid",
  },
  { id: "c-ready-new", parent: R, lane: "ready", role: "coder", briefPath: "existing" },
  {
    id: "c-in-progress",
    parent: R,
    lane: "in_progress",
    role: "coder",
    turns: true,
    attention: ["needs_guidance", "awaiting_approval"],
    briefPath: "missing",
    session: "corrupt",
  },
  { id: "c-yielded", parent: R, lane: "yielded", role: "coder", turns: true, session: "valid" },
  {
    id: "c-done",
    parent: R,
    lane: "done",
    role: "coder",
    turns: true,
    attention: ["awaiting_acceptance"],
    lastOutcome: {
      outcome: "done",
      decision: "terminal",
      round: 0,
      recordedByEventId: "e-1",
      at: iso(50),
    },
    report: true,
    session: "valid",
  },
  {
    id: "c-cancelled",
    parent: R,
    lane: "cancelled",
    role: "coder",
    turns: true,
    laneSince: null,
    session: "valid",
  },
  // Archived and deleted children: lineage (not deleted) but no sidecar row.
  {
    id: "c-archived-done",
    parent: R,
    lane: "done",
    role: "coder",
    archived: true,
    turns: true,
    session: "valid",
  },
  {
    id: "c-archived-running",
    parent: R,
    lane: "in_progress",
    role: "coder",
    archived: true,
    turns: true,
  },
  {
    id: "c-deleted",
    parent: R,
    lane: "done",
    role: "coder",
    deleted: true,
    turns: true,
    session: "valid",
  },
  // Dependencies on archived siblings: done → dropped; in progress → kept, flagged and held (DL-511).
  {
    id: "c-dep-done",
    parent: R,
    lane: "ready",
    role: "coder",
    briefPath: "existing",
    blockedBy: ["c-archived-done"],
  },
  {
    id: "c-dep-wedged",
    parent: R,
    lane: "ready",
    role: "coder",
    briefPath: "existing",
    blockedBy: ["c-archived-running", "c-dep-done"],
  },
  // Duplicate graph keys; the reviewer's routes name a live sibling (kept) and an archived one (dropped).
  { id: "c-dup-1", parent: R, lane: "done", role: "coder", graphKey: "dup", turns: true },
  {
    id: "c-dup-2",
    parent: R,
    lane: "in_progress",
    role: "reviewer",
    graphKey: "dup",
    turns: true,
    routes: [
      { on: ["needs_rework"], kind: "loop", to: "c-dup-1", maxRounds: 2 },
      { on: ["clean"], kind: "resolve" },
      { on: ["stale"], kind: "loop", to: "c-archived-done" },
    ],
  },
  // A pre-1026 spawn: brief text, no path, never started.
  { id: "c-brief-text", parent: R, lane: "ready", role: "coder", brief: "Do the thing." },
  // Roots, one per lane.
  { id: "r-planned-new", lane: "planned", role: "orchestrator" },
  { id: "r-ready", lane: "ready", role: "orchestrator" },
  { id: "r-in-progress", lane: "in_progress", goal: GOAL, turns: true, session: "valid" },
  { id: "r-yielded", lane: "yielded", role: "orchestrator", turns: true },
  { id: "r-done", lane: "done", role: "orchestrator", turns: true, attention: ["needs_guidance"] },
  { id: "r-cancelled", lane: "cancelled", role: "orchestrator", turns: true },
  // Upstream's codex fallback (no model_selection_json) with a pi session: the provider fix.
  {
    id: "r-codex-fallback",
    lane: "in_progress",
    role: "orchestrator",
    modelJson: null,
    turns: true,
    session: "valid",
  },
  // A non-pi row without a session, a plain chat, an archived root.
  {
    id: "r-anthropic",
    lane: "in_progress",
    role: "orchestrator",
    modelJson: '{"instanceId":"anthropic","model":"claude-x"}',
    turns: true,
  },
  { id: "r-chat", lane: "planned", turns: true, session: "valid" },
  { id: "r-archived", lane: "done", goal: GOAL, archived: true, turns: true, session: "valid" },
];

interface Expected {
  readonly status: string;
  readonly session: string;
  readonly held?: boolean;
  readonly outcome?: "done" | "cancelled" | null;
  readonly attention?: ReadonlyArray<string>;
  readonly eligible?: boolean;
}
const EXPECTED: Record<string, Expected> = {
  [R]: { status: "imported", session: "bound", held: false, outcome: null, attention: [] },
  "c-planned-new": {
    status: "imported",
    session: "missing",
    held: true,
    outcome: null,
    attention: [],
  },
  "c-planned-started": {
    status: "imported",
    session: "bound",
    held: false,
    outcome: null,
    attention: [],
  },
  "c-ready-new": {
    status: "imported",
    session: "missing",
    held: false,
    outcome: null,
    attention: [],
    eligible: true,
  },
  "c-in-progress": {
    status: "imported",
    session: "corrupt",
    held: false,
    outcome: null,
    attention: ["needs_guidance"],
  },
  "c-yielded": {
    status: "imported",
    session: "bound",
    held: false,
    outcome: null,
    attention: ["awaiting_orchestrator"],
  },
  "c-done": { status: "imported", session: "bound", held: false, outcome: "done", attention: [] },
  "c-cancelled": {
    status: "imported",
    session: "bound",
    held: false,
    outcome: "cancelled",
    attention: [],
  },
  "c-archived-done": { status: "archived-child", session: "bound" },
  "c-archived-running": { status: "archived-child", session: "missing" },
  "c-deleted": { status: "skipped:deleted", session: "deleted" },
  "c-dep-done": {
    status: "imported",
    session: "missing",
    held: false,
    outcome: null,
    attention: [],
    eligible: true,
  },
  "c-dep-wedged": {
    status: "imported",
    session: "missing",
    held: true,
    outcome: null,
    attention: ["needs_guidance"],
  },
  "c-dup-1": {
    status: "imported",
    session: "missing",
    held: false,
    outcome: "done",
    attention: [],
  },
  "c-dup-2": { status: "imported", session: "missing", held: false, outcome: null, attention: [] },
  "c-brief-text": {
    status: "imported",
    session: "missing",
    held: false,
    outcome: null,
    attention: [],
    eligible: true,
  },
  "r-planned-new": {
    status: "imported",
    session: "missing",
    held: false,
    outcome: null,
    attention: [],
  },
  "r-ready": { status: "imported", session: "missing", held: false, outcome: null, attention: [] },
  "r-in-progress": {
    status: "imported",
    session: "bound",
    held: false,
    outcome: null,
    attention: [],
  },
  "r-yielded": {
    status: "imported",
    session: "missing",
    held: false,
    outcome: null,
    attention: ["awaiting_orchestrator"],
  },
  "r-done": { status: "imported", session: "missing", held: false, outcome: "done", attention: [] },
  "r-cancelled": {
    status: "imported",
    session: "missing",
    held: false,
    outcome: "cancelled",
    attention: [],
  },
  "r-codex-fallback": {
    status: "imported",
    session: "bound",
    held: false,
    outcome: null,
    attention: [],
  },
  "r-anthropic": {
    status: "imported",
    session: "not-pi",
    held: false,
    outcome: null,
    attention: [],
  },
  "r-chat": { status: "skipped:not-workstream", session: "bound" },
  "r-archived": { status: "archived-root", session: "bound" },
};

const turnAt = (index: number) => iso(index * 10 + 2);
const messageAt = (index: number) => iso(index * 10 + 3);

const seedV1 = (directory: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* reconcileMigrationLedgers();
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* runLoomMigrations({ toMigrationInclusive: 1045 });
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${PROJECT}, 'Loom', '/tmp/loom-import-fixture', '[]', ${iso(0)}, ${iso(0)})`;
    yield* sql`INSERT INTO projection_goals (goal_id, project_id, slug, title, description, created_at, updated_at)
      VALUES (${GOAL}, ${PROJECT}, 'goal-one', 'Goal one', 'Why', ${iso(0)}, ${iso(0)})`;
    yield* sql`INSERT INTO projection_goal_tasks (task_id, goal_id, parent_task_id, position, text, done, created_at, updated_at)
      VALUES (${TASK}, ${GOAL}, NULL, 0, 'First task', 0, ${iso(0)}, ${iso(0)})`;
    yield* Effect.forEach(FIXTURES, (row, index) =>
      Effect.gen(function* () {
        const created = iso(index * 10);
        const briefPath =
          row.briefPath === undefined ? null : NodePath.join(directory, "briefs", `${row.id}.md`);
        if (row.briefPath === "existing") {
          NodeFS.mkdirSync(NodePath.dirname(briefPath!), { recursive: true });
          NodeFS.writeFileSync(briefPath!, `Brief for ${row.id}`);
        }
        const reportPath = row.report ? NodePath.join(directory, "reports", `${row.id}.md`) : null;
        if (reportPath !== null) {
          NodeFS.mkdirSync(NodePath.dirname(reportPath), { recursive: true });
          NodeFS.writeFileSync(reportPath, "Report");
        }
        yield* sql`INSERT INTO projection_threads ${sql.insert({
          thread_id: row.id,
          project_id: PROJECT,
          title: row.id,
          model_selection_json: row.modelJson === undefined ? PI_JSON : row.modelJson,
          runtime_mode: "full-access",
          interaction_mode: "default",
          created_at: created,
          updated_at: iso(index * 10 + 5),
          archived_at: row.archived ? iso(500) : null,
          deleted_at: row.deleted ? iso(500) : null,
          parent_thread_id: row.parent ?? null,
          goal_id: row.goal ?? null,
          anchor_task_id: row.anchor ?? null,
          role: row.role ?? null,
          graph_key: row.graphKey ?? null,
          kickoff_brief_path: briefPath,
          brief: row.brief ?? null,
          plan_lane: row.lane,
          plan_lane_since: row.laneSince === undefined ? iso(index * 10 + 4) : row.laneSince,
          attention: JSON.stringify(row.attention ?? []),
          blocked_by: JSON.stringify(row.blockedBy ?? []),
          dependencies_since: row.blockedBy ? created : null,
          routes: JSON.stringify(row.routes ?? []),
          last_outcome: row.lastOutcome ? JSON.stringify(row.lastOutcome) : null,
          report_path: reportPath,
        })}`;
        if (row.turns)
          yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
            VALUES (${row.id}, ${`turn-${row.id}`}, 'completed', ${turnAt(index)}, '[]')`;
        if (row.turns || row.userMessage)
          yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
            VALUES (${`message-${row.id}`}, ${row.id}, 'user', 'hello', 0, ${messageAt(index)}, ${messageAt(index)})`;
      }),
    );
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: NodePath.join(directory, "state.sqlite") })),
  );

/** pi's flat layout under `PI_CODING_AGENT_SESSION_DIR`: `<timestamp>_<id>.jsonl`. */
const writeSessions = (sessionsDir: string) => {
  NodeFS.mkdirSync(sessionsDir, { recursive: true });
  const header = (id: string) =>
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: iso(0), cwd: "/tmp" })}\n`;
  for (const row of FIXTURES) {
    if (row.session === undefined) continue;
    NodeFS.writeFileSync(
      NodePath.join(sessionsDir, `2026-08-01T00-00-00-000Z_${row.id}.jsonl`),
      row.session === "valid" ? header(row.id) : header("someone-else"),
    );
  }
  // An older duplicate of the root's session (a foreign header): the newest file wins.
  const stale = NodePath.join(sessionsDir, `2026-07-01T00-00-00-000Z_${R}.jsonl`);
  NodeFS.writeFileSync(stale, header("someone-else"));
  NodeFS.utimesSync(stale, new Date(T0 - 86_400_000), new Date(T0 - 86_400_000));
};

const sessionPath = (sessionsDir: string, id: string) =>
  NodePath.join(sessionsDir, `2026-08-01T00-00-00-000Z_${id}.jsonl`);

it.effect(
  "imports a V1 workstream database: sidecars, lineage, bindings, ledger; idempotent",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-loom-v1-import-"));
    const sessionsDir = NodePath.join(directory, "pi-sessions");
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
    writeSessions(sessionsDir);

    return Effect.gen(function* () {
      yield* seedV1(directory);
      const config = yield* ServerConfig.ServerConfig;
      const configLayer = ServerConfig.layer({
        ...config,
        dbPath: NodePath.join(directory, "statev2.sqlite"),
      });
      const database = SqlitePersistence.layerConfig.pipe(Layer.provide(configLayer));
      const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(database),
      );
      const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
      const importers = Layer.mergeAll(
        LegacyV1ThreadImporter.layer,
        LoomV1WorkstreamImporter.layer,
      ).pipe(Layer.provideMerge(sink), Layer.provideMerge(configLayer));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const upstream = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* upstream.reconcileShells;
        // Upstream's codex fallback for both rows the provider fix must repair.
        const fallback = yield* sql<{ thread_id: string; provider_instance_id: string }>`
        SELECT thread_id, provider_instance_id FROM orchestration_v2_projection_threads
        WHERE thread_id IN ('r-codex-fallback', 'c-planned-started') ORDER BY thread_id`;
        assert.deepStrictEqual(
          fallback.map((row) => row.provider_instance_id),
          ["codex", "codex"],
        );
        yield* LoomV1WorkstreamImporter.reconcile;

        const ledger = new Map(
          (yield* sql<{
            thread_id: string;
            status: string;
            session_status: string;
            session_path: string | null;
            sidecar_written: number;
            lineage_reemitted: number;
            warnings_json: string;
          }>`SELECT * FROM loom_legacy_imports`).map((row) => [row.thread_id, row] as const),
        );
        // The ledger covers every imported V1 row (verify.sql G).
        assert.strictEqual(ledger.size, FIXTURES.length);
        const [pendingCount] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n
        FROM orchestration_v2_legacy_imports li LEFT JOIN loom_legacy_imports l USING (thread_id)
        WHERE l.thread_id IS NULL`;
        assert.strictEqual(pendingCount!.n, 0);

        const rows = new Map<string, LoomThreadWorkstream>();
        for (const fixture of FIXTURES) {
          const row = yield* readWorkstream(sql, ThreadId.make(fixture.id));
          if (row !== null) rows.set(fixture.id, row);
        }
        const nodes = new Map<ThreadId, StartNode>(
          [...rows.values()].map((row) => [row.threadId, { ...row, id: row.threadId }]),
        );

        for (const fixture of FIXTURES) {
          const expected = EXPECTED[fixture.id]!;
          const entry = ledger.get(fixture.id)!;
          const index = FIXTURES.indexOf(fixture);
          const label = (what: string) => `${fixture.id}: ${what}`;
          assert.strictEqual(entry.status, expected.status, label("ledger status"));
          assert.strictEqual(entry.session_status, expected.session, label("session status"));
          const row = rows.get(fixture.id);
          assert.strictEqual(
            row !== undefined,
            expected.status === "imported",
            label("sidecar row"),
          );
          assert.strictEqual(
            entry.sidecar_written,
            row === undefined ? 0 : 1,
            label("sidecar_written"),
          );

          // Lineage: every non-deleted child says subagent under its V1 parent, rooted at R.
          const [v2] = yield* sql<{ payload_json: string; provider_instance_id: string }>`
          SELECT payload_json, provider_instance_id FROM orchestration_v2_projection_threads
          WHERE thread_id = ${fixture.id}`;
          const thread = JSON.parse(v2!.payload_json);
          const isLiveChild = fixture.parent !== undefined && !fixture.deleted;
          assert.deepStrictEqual(
            thread.lineage,
            isLiveChild
              ? { parentThreadId: R, relationshipToParent: "subagent", rootThreadId: R }
              : { parentThreadId: null, relationshipToParent: null, rootThreadId: fixture.id },
            label("lineage"),
          );
          assert.strictEqual(
            entry.lineage_reemitted,
            isLiveChild ? 1 : 0,
            label("lineage_reemitted"),
          );

          // Binding only on a valid file: a strong pi ref at that path, and the thread points at it.
          const providerThreads = yield* sql<{ provider_thread_id: string; payload_json: string }>`
          SELECT provider_thread_id, payload_json FROM orchestration_v2_projection_provider_threads
          WHERE thread_id = ${fixture.id}`;
          if (expected.session === "bound") {
            const path = sessionPath(sessionsDir, fixture.id);
            assert.strictEqual(entry.session_path, path, label("session_path"));
            assert.lengthOf(providerThreads, 1, label("provider thread"));
            const providerThread = JSON.parse(providerThreads[0]!.payload_json);
            assert.deepStrictEqual(providerThread.nativeThreadRef, {
              driver: "pi",
              nativeId: path,
              strength: "strong",
            });
            assert.strictEqual(providerThread.providerInstanceId, "pi");
            assert.strictEqual(
              thread.activeProviderThreadId,
              deriveProviderThread({ driver: ProviderDriverKind.make("pi"), nativeThreadId: path }),
              label("activeProviderThreadId"),
            );
            assert.strictEqual(v2!.provider_instance_id, "pi", label("provider fixed"));
          } else {
            assert.lengthOf(providerThreads, 0, label("no provider thread"));
            assert.isNull(
              thread.activeProviderThreadId ?? null,
              label("no active provider thread"),
            );
          }

          if (row === undefined) continue;
          const started = fixture.turns === true || fixture.userMessage === true;
          assert.strictEqual(
            row.kickoffAt,
            fixture.turns ? turnAt(index) : fixture.userMessage ? messageAt(index) : null,
            label("kickoffAt"),
          );
          assert.strictEqual(row.held, expected.held, label("held"));
          assert.strictEqual(
            row.heldSince,
            row.held ? iso(index * 10 + 4) : null,
            label("heldSince"),
          );
          assert.strictEqual(row.outcome, expected.outcome, label("outcome"));
          assert.strictEqual(
            row.outcomeAt,
            row.outcome === null
              ? null
              : fixture.laneSince === undefined
                ? iso(index * 10 + 4)
                : iso(index * 10 + 5),
            label("outcomeAt"),
          );
          assert.deepStrictEqual(row.attention, expected.attention, label("attention"));
          assert.strictEqual(row.rootThreadId, fixture.parent === undefined ? fixture.id : R);
          // Episode columns stay null: no rail fires for history.
          assert.isNull(row.outcomeEventId);
          assert.isNull(row.lastRoute);
          assert.isNull(row.unarchivedEventId);
          assert.deepStrictEqual(row.attentionEpisodes, {});
          assert.deepStrictEqual(row.notifySendLog, []);
          if (started)
            assert.isFalse(isEligibleToStart(nodes.get(row.threadId)!, nodes), label("started"));
          assert.strictEqual(
            isEligibleToStart(nodes.get(row.threadId)!, nodes),
            expected.eligible === true,
            label("eligible"),
          );
        }

        // Column-mapping specifics.
        const get = (id: string) => rows.get(id)!;
        assert.strictEqual(get(R).goalId, GOAL);
        assert.strictEqual(get(R).anchorTaskId, TASK);
        assert.deepStrictEqual(get("c-done").lastOutcome, {
          outcome: "done",
          decision: "terminal",
          round: 0,
          eventId: null,
          at: iso(50),
        });
        assert.strictEqual(
          get("c-done").reportPath,
          NodePath.join(directory, "reports", "c-done.md"),
        );
        assert.deepStrictEqual(get("c-dep-done").blockedBy, []);
        assert.isNull(get("c-dep-done").dependenciesSince);
        assert.deepStrictEqual(get("c-dep-wedged").blockedBy, [
          ThreadId.make("c-archived-running"),
          ThreadId.make("c-dep-done"),
        ]);
        assert.strictEqual(get("c-dup-1").graphKey, "dup");
        assert.isNull(get("c-dup-2").graphKey);
        assert.deepStrictEqual(get("c-dup-2").routes, [
          { on: ["needs_rework"], kind: "loop", to: ThreadId.make("c-dup-1"), maxRounds: 2 },
          { on: ["clean"], kind: "resolve" },
        ]);
        // A started thread keeps a missing brief path; an unstarted one would be unbriefed.
        assert.strictEqual(
          get("c-in-progress").kickoffBriefPath,
          NodePath.join(directory, "briefs", "c-in-progress.md"),
        );
        const writtenBrief = NodePath.join(config.stateDir, "workstream-briefs", "c-brief-text.md");
        assert.strictEqual(get("c-brief-text").kickoffBriefPath, writtenBrief);
        assert.strictEqual(NodeFS.readFileSync(writtenBrief, "utf8"), "Do the thing.");
        assert.include(ledger.get("c-dup-2")!.warnings_json, "graph key dup");
        assert.include(ledger.get("c-dep-wedged")!.warnings_json, "kept: unsatisfiable");

        // The provider fix: upstream's codex fallback becomes pi, with V1's own pi model when it has one.
        const modelOf = (id: string) =>
          sql<{ payload_json: string }>`SELECT payload_json FROM orchestration_v2_projection_threads
          WHERE thread_id = ${id}`.pipe(
            Effect.map(([row]) => JSON.parse(row!.payload_json).modelSelection),
          );
        assert.deepStrictEqual(yield* modelOf("r-codex-fallback"), {
          instanceId: "pi",
          model: PI_DEFAULT_MODEL,
        });
        assert.deepStrictEqual(yield* modelOf("c-planned-started"), {
          instanceId: "pi",
          model: "cliproxy/claude-fable-5-1",
        });
        assert.deepStrictEqual(yield* modelOf("r-anthropic"), {
          instanceId: "anthropic",
          model: "claude-x",
        });

        // verify.sql C, E and F — every invariant 0.
        const zero = (statement: string) =>
          sql
            .unsafe<{ n: number }>(statement)
            .pipe(Effect.map(([row]) => assert.strictEqual(row!.n, 0, statement)));
        yield* zero(
          `SELECT COUNT(*) AS n FROM loom_thread_workstream WHERE outcome IS NOT NULL AND (held = 1 OR attention != '[]')`,
        );
        yield* zero(`SELECT COUNT(*) AS n FROM loom_thread_workstream WHERE outcome_event_id IS NOT NULL OR unarchived_event_id IS NOT NULL OR last_route IS NOT NULL
        OR json_extract(last_outcome, '$.eventId') IS NOT NULL`);
        yield* zero(`SELECT COUNT(*) AS n FROM loom_thread_workstream w
        WHERE kickoff_at IS NULL AND EXISTS (SELECT 1 FROM projection_turns u WHERE u.thread_id = w.thread_id)`);
        yield* zero(`SELECT COUNT(*) AS n FROM loom_thread_workstream w, json_each(w.blocked_by) d
        WHERE NOT EXISTS (SELECT 1 FROM loom_thread_workstream x WHERE x.thread_id = d.value)
          AND NOT EXISTS (SELECT 1 FROM json_each(w.attention) a WHERE a.value = 'needs_guidance')`);
        yield* zero(`SELECT COUNT(*) AS n FROM loom_thread_workstream w, json_each(w.routes) r
        WHERE json_extract(r.value, '$.to') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM loom_thread_workstream x WHERE x.thread_id = json_extract(r.value, '$.to'))`);
        yield* zero(`SELECT COUNT(*) AS n FROM loom_thread_workstream w JOIN orchestration_v2_projection_threads p USING (thread_id)
        WHERE w.parent_thread_id IS NOT NULL
          AND (json_extract(p.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
            OR json_extract(p.payload_json, '$.lineage.parentThreadId') IS NOT w.parent_thread_id)`);
        yield* zero(`SELECT COUNT(*) AS n FROM projection_threads t JOIN orchestration_v2_projection_threads p USING (thread_id)
        WHERE t.deleted_at IS NULL AND t.parent_thread_id IS NOT NULL
          AND json_extract(p.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'`);
        yield* zero(`SELECT COUNT(*) AS n FROM loom_legacy_imports l JOIN orchestration_v2_projection_threads p USING (thread_id)
        WHERE l.session_status = 'bound' AND (
          json_extract(p.payload_json, '$.activeProviderThreadId') IS NULL
          OR NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads pt
                          WHERE pt.thread_id = l.thread_id AND pt.driver = 'pi'
                            AND json_extract(pt.payload_json, '$.nativeThreadRef.strength') = 'strong'
                            AND json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = l.session_path))`);
        yield* zero(`SELECT COUNT(*) AS n FROM loom_legacy_imports l JOIN orchestration_v2_projection_threads p USING (thread_id)
        WHERE l.session_status = 'bound' AND p.provider_instance_id != 'pi'`);

        // Idempotence: a second boot writes nothing; nor does a full re-run after clearing the ledger.
        const snapshot = sql<{ events: number; sidecars: string; ledger: string }>`SELECT
        (SELECT COUNT(*) FROM orchestration_events) AS events,
        (SELECT json_group_array(json_object('t', thread_id, 'u', updated_at)) FROM loom_thread_workstream) AS sidecars,
        (SELECT json_group_array(thread_id || session_status) FROM loom_legacy_imports) AS ledger`;
        const before = yield* snapshot;
        yield* upstream.reconcileShells;
        yield* LoomV1WorkstreamImporter.reconcile;
        assert.deepStrictEqual(yield* snapshot, before);
        yield* sql`DELETE FROM loom_legacy_imports`;
        yield* LoomV1WorkstreamImporter.reconcile;
        const [{ events }] = (yield* snapshot) as unknown as [{ events: number }];
        assert.strictEqual(events, before[0]!.events);
        const rerun = yield* sql<{
          session_status: string;
          sidecar_written: number;
          lineage_reemitted: number;
        }>`
        SELECT session_status, sidecar_written, lineage_reemitted FROM loom_legacy_imports`;
        assert.isTrue(
          rerun.every((row) => row.sidecar_written === 0 && row.lineage_reemitted === 0),
        );
        assert.isFalse(rerun.some((row) => row.session_status === "bound"));
      }).pipe(Effect.provide(importers));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
          else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
      ),
    );
  },
);
