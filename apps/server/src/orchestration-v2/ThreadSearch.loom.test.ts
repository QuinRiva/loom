import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationSearchThreadsInput,
  type OrchestrationThreadSearchMatch,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerTest as serverConfigLayerTest } from "../config.ts";
import { writeWorkstreamReport } from "../loom/workstream/report.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { EmbeddingError, type EmbeddingProvider } from "./embedding/EmbeddingProvider.loom.ts";
import { ThreadEmbedder, makeThreadEmbedder } from "./ThreadEmbedder.loom.ts";
import { layer as threadSearchLayer, makeThreadSearch } from "./ThreadSearch.loom.ts";
import { searchThreadsWithOlderSettledRows, ThreadSearch } from "./ThreadSearch.ts";

const layer = it.layer(
  SqlitePersistence.layerMemory.pipe(
    Layer.provideMerge(
      serverConfigLayerTest(process.cwd(), { prefix: "thread-search-test" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const reset = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_threads",
    "loom_thread_workstream",
    "projection_projects",
    "loom_thread_embeddings",
  ])
    yield* sql.unsafe(`DELETE FROM ${table}`);
  for (const project of ["project", "other"])
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${project}, 'Project', ${`/tmp/${project}`}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
});

/** A V2 thread; a child also gets the workstream sidecar row a spawn writes. */
const thread = (
  id: string,
  title: string,
  fields: {
    parent?: string;
    purpose?: string;
    archivedAt?: string;
    updatedAt?: string;
    project?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lineage = {
      parentThreadId: fields.parent ?? null,
      relationshipToParent: fields.parent ? "subagent" : null,
      rootThreadId: fields.parent ?? id,
    };
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
       created_at, updated_at, archived_at, payload_json)
      VALUES (${id}, ${fields.project ?? "project"}, ${title}, 'pi', 'full-access', 'default', '2026-01-01T00:00:00.000Z',
        ${fields.updatedAt ?? "2026-01-02T00:00:00.000Z"}, ${fields.archivedAt ?? null},
        ${JSON.stringify({ lineage })})`;
    if (fields.parent || fields.purpose)
      yield* sql`INSERT INTO loom_thread_workstream
        (thread_id, project_id, parent_thread_id, root_thread_id, purpose, created_at, updated_at)
        VALUES (${id}, 'project', ${fields.parent ?? null}, ${lineage.rootThreadId},
          ${fields.purpose ?? null}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  });

let clock = 0;
const message = (
  id: string,
  threadId: string,
  role: "user" | "assistant",
  text: string,
  fields: { streaming?: boolean; origin?: string; runId?: string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = `2026-01-01T00:00:${String(++clock % 60).padStart(2, "0")}.000Z`;
    const payload = { text, ...(fields.origin ? { loom: { origin: fields.origin } } : {}) };
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${id}, ${threadId}, ${fields.runId ?? null}, ${role}, ${fields.streaming ? 1 : 0},
        ${at}, ${at}, ${JSON.stringify(payload)})`;
  });

/** Full scope unless a test says otherwise: most cases here test what the index holds. */
const search = (query: string, options: Partial<OrchestrationSearchThreadsInput> = {}) =>
  makeThreadSearch.pipe(
    Effect.flatMap((threadSearch) =>
      threadSearch.searchThreads({ scope: "all", ...options, query }),
    ),
    Effect.map(({ matches }) => matches),
  );

/** Fixed vectors by exact text; anything else is a near-zero vector. */
const stubProvider = (
  vectors: Record<string, ReadonlyArray<number>>,
  options: { documentsFail?: boolean } = {},
): EmbeddingProvider => ({
  name: "stub/test",
  embed: (texts, kind) =>
    kind === "document" && options.documentsFail
      ? Effect.fail(new EmbeddingError({ message: "documents unavailable" }))
      : Effect.succeed(texts.map((text) => Float32Array.from(vectors[text] ?? [0.01, 0.01]))),
});

layer("ThreadSearch", (it) => {
  it.effect("stems, credits a sub-thread's brief to its root, and returns archived roots", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("archived-root", "Sidebar rehome", { archivedAt: "2026-01-03T00:00:00.000Z" });
      yield* thread("root", "Unrelated work");
      yield* thread("child", "Wiring audit", { parent: "root" });
      yield* message("kickoff", "child", "user", "Investigate the flux capacitor wiring", {
        origin: "kickoff",
      });

      const [stemmed] = yield* search("rehoming");
      assert.deepStrictEqual(
        [stemmed?.threadId, stemmed?.source, stemmed?.archivedAt],
        ["archived-root", "title", "2026-01-03T00:00:00.000Z"],
      );

      const credited = yield* search("flux capacitor");
      assert.deepStrictEqual(
        credited.map((match) => [
          match.threadId,
          match.source,
          match.matchedThreadId,
          match.matchedThreadTitle,
        ]),
        [["root", "brief", "child", "Wiring audit"]],
      );

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET deleted_at = '2026-01-04T00:00:00.000Z' WHERE thread_id = 'child'`;
      assert.deepStrictEqual(yield* search("flux capacitor"), []);
      assert.deepStrictEqual(yield* search("wiring audit"), []);
    }),
  );

  it.effect("includeArchived: false drops archived roots from both rankings", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("archived", "nebula survey", { archivedAt: "2026-01-03T00:00:00.000Z" });
      yield* thread("archived-child", "Probe", { parent: "archived", purpose: "nebula drift" });
      yield* thread("live", "nebula notes");
      const ids = (matches: ReadonlyArray<{ readonly threadId: string }>) =>
        matches.map((match) => match.threadId).toSorted();

      assert.deepStrictEqual(ids(yield* search("nebula")), ["archived", "live"]);
      // The child's purpose hit must not resurrect its archived root.
      assert.deepStrictEqual(ids(yield* search("nebula", { includeArchived: false })), ["live"]);
      assert.deepStrictEqual(ids(yield* search("drift", { includeArchived: false })), []);

      // Semantic side: the archived root is the nearest vector, yet stays out.
      const embedder = yield* makeThreadEmbedder(
        Effect.succeed(stubProvider({ cosmos: [1, 0], "nebula survey\nProbe": [1, 0] })),
      );
      yield* embedder.sweep;
      const semantic = (includeArchived: boolean) =>
        search("cosmos", { includeArchived }).pipe(Effect.provideService(ThreadEmbedder, embedder));
      assert.equal((yield* semantic(true))[0]?.threadId, "archived");
      assert.notInclude(ids(yield* semantic(false)), "archived");
    }),
  );

  it.effect("projectId keeps other projects' roots out of both rankings", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("here", "pulsar timing");
      yield* thread("there", "pulsar timing", { project: "other" });
      assert.deepStrictEqual(
        (yield* search("pulsar", { projectId: ProjectId.make("project") })).map(
          (match) => match.threadId,
        ),
        ["here"],
      );
      const embedder = yield* makeThreadEmbedder(
        Effect.succeed(stubProvider({ quasar: [1, 0], "pulsar timing": [1, 0] })),
      );
      yield* embedder.sweep;
      assert.deepStrictEqual(
        (yield* search("quasar", { projectId: ProjectId.make("other") }).pipe(
          Effect.provideService(ThreadEmbedder, embedder),
        )).map((match) => match.threadId),
        ["there"],
      );
    }),
  );

  it.effect("the client's projectIds apply before the limit", () =>
    Effect.gen(function* () {
      yield* reset;
      for (const index of [1, 2, 3])
        yield* thread(`there-${index}`, "pulsar timing pulsar", { project: "other" });
      yield* thread("here", "Notes");
      yield* message("ask", "here", "user", "a long note that mentions a pulsar once, in passing");
      const service = yield* ThreadSearch.pipe(Effect.provide(threadSearchLayer));
      const sql = yield* SqlClient.SqlClient;
      const viaClient = (projectIds?: ReadonlyArray<ProjectId>) =>
        searchThreadsWithOlderSettledRows({
          request: { query: "pulsar", limit: 1, ...(projectIds ? { projectIds } : {}) },
          search: service.search,
          searchOlderSettled: () => Effect.succeed([]),
          sql,
          readThreads: () => Effect.succeed(Effect.die("unused without olderSettledBefore")),
          latestSequence: Effect.succeed(0),
        }).pipe(Effect.map(({ matches }) => matches.map((match): string => match.threadId)));

      assert.notDeepEqual(yield* viaClient(), ["here"]);
      assert.deepStrictEqual(yield* viaClient([ProjectId.make("project")]), ["here"]);
    }),
  );

  it.effect("nests sub-thread rows best first, counts the rest, and never exceeds the limit", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("root", "Orbital work", { updatedAt: "2026-01-05T00:00:00.000Z" });
      yield* thread("by-title", "comet survey", { parent: "root" });
      yield* thread("by-purpose", "Probe", { parent: "root", purpose: "chart the comet" });
      yield* thread("by-message", "Relay", { parent: "root" });
      yield* message(
        "relay-ask",
        "by-message",
        "user",
        "is the comet visible from the relay today",
      );
      yield* thread("by-answer", "Archive", { parent: "root" });
      yield* message("archive-answer", "by-answer", "assistant", "the comet left the frame");
      yield* thread("other", "comet notes");
      yield* thread("other-child", "comet debris", { parent: "other" });

      const rows = (limit: number) =>
        search("comet", { subThreadRows: true, limit }).pipe(
          Effect.map((matches) =>
            matches.map((match): [string, ReadonlyArray<string>, number | undefined] => [
              match.threadId,
              (match.subThreads ?? []).map((sub) => sub.threadId),
              match.subThreadsOmitted,
            ]),
          ),
        );
      // By each sub-thread's best document: title, purpose, then the short answer over the long ask.
      const best = ["by-title", "by-purpose", "by-answer"];
      assert.deepStrictEqual(yield* rows(30), [
        ["root", best, 1],
        ["other", ["other-child"], 0],
      ]);
      // The last root that fits keeps its row and folds the sub-thread rows that do not.
      assert.deepStrictEqual(yield* rows(5), [
        ["root", best, 1],
        ["other", [], 1],
      ]);
      assert.deepStrictEqual(yield* rows(4), [["root", best, 1]]);
      assert.deepStrictEqual(yield* rows(2), [["root", ["by-title"], 3]]);
      const [relay] = (yield* search("relay visible", { subThreadRows: true }))[0]!.subThreads!;
      assert.deepStrictEqual(
        [relay?.threadId, relay?.title, relay?.source, relay?.messageId, relay?.archivedAt],
        ["by-message", "Relay", "user", "relay-ask", null],
      );
      // Without the flag, or under the roots scope, a match carries no sub-thread rows.
      assert.isUndefined((yield* search("comet"))[0]?.subThreads);
      assert.isUndefined(
        (yield* search("comet", { subThreadRows: true, scope: "roots" }))[0]?.subThreads,
      );
    }),
  );

  it.effect("rootThreadId unfolds one workstream, its sub-thread rows up to the limit", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("root", "Orbital work");
      for (const index of [1, 2, 3, 4, 5])
        yield* thread(`child-${index}`, `comet leg ${index}`, { parent: "root" });
      yield* thread("other", "comet notes");
      yield* writeWorkstreamReport(ThreadId.make("child-5"), "The comet report.");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE loom_thread_workstream SET report_path = '/reports/child-5.md'
        WHERE thread_id = 'child-5'`;

      const [unfolded, ...rest] = yield* search("comet", {
        subThreadRows: true,
        rootThreadId: ThreadId.make("root"),
        limit: 4,
      });
      assert.deepStrictEqual(rest, []);
      assert.equal(unfolded?.threadId, "root");
      assert.equal(unfolded?.subThreads?.length, 3);
      assert.equal(unfolded?.subThreadsOmitted, 2);
      const report = (yield* search("comet report", {
        subThreadRows: true,
        rootThreadId: ThreadId.make("root"),
      }))[0]?.subThreads?.[0];
      assert.deepStrictEqual(
        [report?.threadId, report?.source, report?.reportPath],
        ["child-5", "report", "/reports/child-5.md"],
      );
    }),
  );

  it.effect(
    "an archived sub-thread gets a row, marked, only when archived threads are included",
    () =>
      Effect.gen(function* () {
        yield* reset;
        yield* thread("root", "Orbital work");
        yield* thread("live-child", "comet live", { parent: "root" });
        yield* thread("archived-child", "comet shelved", {
          parent: "root",
          archivedAt: "2026-01-03T00:00:00.000Z",
        });
        const subs = (includeArchived: boolean) =>
          search("comet", { subThreadRows: true, includeArchived }).pipe(
            Effect.map((matches) =>
              (matches[0]?.subThreads ?? []).map((sub) => [sub.threadId, sub.archivedAt]),
            ),
          );
        assert.deepStrictEqual(yield* subs(false), [["live-child", null]]);
        assert.sameDeepMembers(yield* subs(true), [
          ["live-child", null],
          ["archived-child", "2026-01-03T00:00:00.000Z"],
        ]);
      }),
  );

  it.effect("a root found only by meaning is listed only above the model's cut-off", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("close", "alpha");
      yield* thread("far", "beta");
      yield* thread("worded", "nebula notes");
      // The model the cut-off table holds: listed by meaning at similarity >= 0.62 and >= 0.045
      // above the query's mean.
      const embedder = yield* makeThreadEmbedder(
        Effect.succeed({
          ...stubProvider({
            nebula: [1, 0],
            comet: [0.8, 0.6],
            alpha: [1, 0],
            beta: [0.5, Math.sqrt(0.75)],
            "nebula notes": [0, 1],
          }),
          name: "vertex/gemini-embedding-001",
        }),
      );
      yield* embedder.sweep;
      const ids = (query: string) =>
        search(query).pipe(
          Effect.provideService(ThreadEmbedder, embedder),
          Effect.map((matches) => matches.map((match) => match.threadId)),
        );
      // Mean 0.5, so 0.62 decides: "far" (0.5) is cut; "worded" stays on its word match
      // though it is the farthest vector.
      assert.sameMembers(yield* ids("nebula"), ["close", "worded"]);
      // Mean 0.77, so the margin decides: "close" (0.8) clears 0.62 and the mean, but by less
      // than 0.045, and is cut; "far" (0.92) stays.
      assert.deepStrictEqual(yield* ids("comet"), ["far"]);
    }),
  );

  it.effect("indexes prompts and each run's answer only once finalised, never notices", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      yield* thread("root", "Root");
      yield* message("notice", "root", "user", "heliopause", { origin: "control_notice" });
      yield* message("interim", "root", "assistant", "magnetar", { runId: "run" });
      yield* message("final", "root", "assistant", "perihelion", {
        runId: "run",
        streaming: true,
      });

      assert.deepStrictEqual(yield* search("heliopause"), []);
      // The interim answer is the run's answer until a later one finalises.
      assert.equal((yield* search("magnetar"))[0]?.source, "assistant");
      assert.deepStrictEqual(yield* search("perihelion"), []);

      yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0 WHERE message_id = 'final'`;
      const [final] = yield* search("perihelion");
      assert.deepStrictEqual([final?.threadId, final?.source], ["root", "assistant"]);
      assert.deepStrictEqual(yield* search("magnetar"), []);
    }),
  );

  it.effect("indexes the latest workstream report, replacing the previous round", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("root", "Root");
      yield* thread("child", "Child", { parent: "root" });

      yield* writeWorkstreamReport(ThreadId.make("child"), "First round found a quasar.");
      const [first] = yield* search("quasar");
      assert.deepStrictEqual(
        [first?.threadId, first?.source, first?.matchedThreadId],
        ["root", "report", "child"],
      );

      yield* writeWorkstreamReport(ThreadId.make("child"), "Second round found a pulsar.", 1);
      assert.deepStrictEqual(yield* search("quasar"), []);
      assert.equal((yield* search("pulsar"))[0]?.threadId, "root");
    }),
  );

  it.effect("limits by root, and without an embedder returns the lexical order", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("full", "alpha omega launch", { updatedAt: "2026-01-01T00:00:00.000Z" });
      yield* thread("partial", "alpha review", { updatedAt: "2026-01-05T00:00:00.000Z" });
      for (const index of [1, 2, 3])
        yield* thread(`child-${index}`, `alpha omega child ${index}`, { parent: "partial" });

      // Three matching sub-threads still make one root, and `limit` counts roots.
      assert.deepStrictEqual(
        (yield* search("alpha omega")).map((match) => match.threadId).toSorted(),
        ["full", "partial"],
      );
      assert.equal((yield* search("alpha omega", { limit: 1 })).length, 1);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id LIKE 'child-%'`;
      // "full" covers both terms, "partial" only one.
      assert.deepStrictEqual(
        (yield* search("alpha omega")).map((match) => match.threadId),
        ["full", "partial"],
      );
    }),
  );

  it.effect("fuses only full-coverage lexical roots with the semantic ranking", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("full", "alpha omega launch");
      yield* thread("partial", "alpha");
      yield* thread("semantic", "gamma");
      const embedder = yield* makeThreadEmbedder(
        Effect.succeed(
          stubProvider({
            "alpha omega": [1, 0],
            gamma: [1, 0],
            alpha: [0.6, 0.8],
            "alpha omega launch": [0, 1],
          }),
        ),
      );
      yield* embedder.sweep;
      const matches = yield* search("alpha omega").pipe(
        Effect.provideService(ThreadEmbedder, embedder),
      );
      // full: lexical #1 + semantic #3; semantic: semantic #1; partial: semantic #2 only.
      // Had "partial" kept its lexical vote (#2) it would outrank "semantic".
      assert.deepStrictEqual(
        matches.map((match) => match.threadId),
        ["full", "semantic", "partial"],
      );
    }),
  );

  it.effect("serves upstream's service with the roots scope by default", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* thread("root", "Orbital work");
      yield* thread("child", "Comet probe", { parent: "root" });
      yield* message("root-ask", "root", "user", "plan the aphelion burn");
      yield* message("kickoff", "child", "user", "Map the aphelion debris", { origin: "kickoff" });
      yield* message("child-ask", "child", "user", "check the meteoroid field");
      yield* writeWorkstreamReport(ThreadId.make("child"), "Found aphelion debris.");
      const service = yield* ThreadSearch.pipe(Effect.provide(threadSearchLayer));
      const shape = ({
        matches,
      }: {
        readonly matches: ReadonlyArray<OrchestrationThreadSearchMatch>;
      }) =>
        matches.map((match) => [
          match.threadId,
          match.source,
          match.matchedThreadId ?? null,
          match.messageId ?? null,
        ]);

      // The root's own message, with its id for the jump; the child's text stays out.
      assert.deepStrictEqual(shape(yield* service.search({ query: "aphelion burn" })), [
        ["root", "user", null, "root-ask"],
      ]);
      assert.deepStrictEqual(shape(yield* service.search({ query: "comet probe" })), []);
      // A child's report is the root's; its brief and messages need `all`.
      assert.deepStrictEqual(shape(yield* service.search({ query: "found debris" })), [
        ["root", "report", "child", null],
      ]);
      assert.deepStrictEqual(shape(yield* service.search({ query: "meteoroid" })), []);
      assert.deepStrictEqual(shape(yield* service.search({ query: "meteoroid", scope: "all" })), [
        ["root", "user", "child", null],
      ]);

      yield* thread("other", "aphelion notes");
      const { matches } = yield* service.search({ query: "aphelion" });
      assert.deepStrictEqual(
        matches.map((match) => match.quality),
        [1, 0.999],
      );
      assert.deepStrictEqual(
        (yield* service.searchThreads({ query: "aphelion" })).matches
          .map((hit) => hit.threadId)
          .toSorted(),
        ["other", "root"],
      );
      assert.deepStrictEqual(
        yield* service.searchOlderSettled({
          query: "aphelion",
          before: "2026-01-01T00:00:00.000Z",
          messageThreadIds: [],
        }),
        [],
      );
    }),
  );

  it.effect("never fuses vectors stored under another provider's identity", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      yield* thread("current", "alpha");
      yield* thread("stale", "gamma");
      const vector = (values: ReadonlyArray<number>) =>
        new Uint8Array(Float32Array.from(values).buffer);
      yield* sql`INSERT INTO loom_thread_embeddings (thread_id, identity, source_hash, vector, updated_at) VALUES
        ('current', 'stub/test/2', 'x', ${vector([0, 1])}, '2026-01-01T00:00:00.000Z'),
        ('stale', 'other/model/2', 'x', ${vector([1, 0])}, '2026-01-01T00:00:00.000Z')`;
      // Documents fail, so the sweep cannot replace the stale row: only the
      // identity-matched vector is loaded.
      const embedder = yield* makeThreadEmbedder(
        Effect.succeed(stubProvider({ query: [1, 0] }, { documentsFail: true })),
      );
      yield* embedder.sweep;
      assert.deepStrictEqual((yield* embedder.nearest("query", 50))?.ids, ["current"]);
    }),
  );
});
