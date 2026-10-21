/**
 * Query threads on the real orchestrator (plans/plan-query-threads/plan.mdx §2): one live
 * query thread per (author, file, revision), reused while the content hash holds and superseded
 * (done, archived) once it changes; a mid-turn author defers the fork, and the reactor sends
 * the fork and the overlay-led first question once the author's run ends.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DOCUMENT_QUERY_ROLE,
  type DocumentQueryInput,
  type IsoDateTime,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { splitDocumentQueryKickoff } from "@t3tools/shared/documentQuery.loom";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import {
  HandoffDrafterReactor,
  HandoffDrafterReactorServiceLive,
} from "../handoff/HandoffDrafterReactor.ts";
import { emptyWorkstream, LoomStoreV2 } from "../projection/LoomStore.ts";
import {
  completeSeededRun,
  LoomOrchestratorTestLayer,
  seedRunningRun,
  seedThread,
} from "../testkit/loomOrchestratorLayer.ts";
import type { WorkstreamCaller } from "../../mcp/toolkits/workstream/authorisation.ts";
import { documentQueryPromote } from "../../mcp/toolkits/workstream/handlers/documentQuery.ts";
import {
  askDocumentQuery,
  promoteDocumentQuery,
  buildDocumentQueryBrief,
  parseDocumentQueryBrief,
  reusableQueryThread,
  supersededQueryThreads,
} from "./documentQuery.ts";
import { buildDocumentQueryOverlay } from "./documentQueryOverlay.ts";

const pi = ProviderDriverKind.make("pi");
let documentContents = "# Plan v1";

const TestLayer = Layer.mergeAll(
  HandoffDrafterReactorServiceLive,
  ProjectStore.layer,
  Layer.mock(WorkspaceFileSystem)({
    readFile: (input) =>
      Effect.succeed({
        relativePath: input.relativePath,
        contents: documentContents,
        byteLength: documentContents.length,
        truncated: false,
      }),
  }),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-query-" }),
).pipe(Layer.provideMerge(LoomOrchestratorTestLayer), Layer.provideMerge(NodeServices.layer));

const filePath = "plans/read-lane/plan.mdx";
const ask = (sourceThreadId: ThreadId, question: string): DocumentQueryInput => ({
  sourceThreadId,
  filePath,
  anchor: { textQuote: "a write that crossed the port", sectionId: "s2" },
  quotedText: "a write that crossed the port would lose the transaction",
  sectionId: "s2",
  sectionTitle: "2. One reader lane",
  rangeLabel: "§2",
  question,
});
const row = (threadId: ThreadId) =>
  Effect.flatMap(LoomStoreV2, (store) => Effect.map(store.getWorkstream(threadId), (r) => r!));
const messagesOf = (threadId: ThreadId) =>
  Effect.map(
    Effect.flatMap(Orchestrator.OrchestratorV2, (o) => o.getThreadProjection(threadId)),
    (projection) => projection.messages,
  );
const forksOf = (threadId: ThreadId) =>
  Effect.map(
    Effect.flatMap(Orchestrator.OrchestratorV2, (o) =>
      o.getThreadRecords(threadId, ["contextTransfers"]),
    ),
    (records) => records.contextTransfers,
  );
const settlePass = Effect.flatMap(HandoffDrafterReactor, (reactor) => reactor.runPass);

it("reuses the live query thread for the revision and supersedes stale ones", () => {
  const author = ThreadId.make("author");
  const at = "2026-01-01T00:00:00.000Z" as IsoDateTime;
  const query = (id: string, revision: string, extra: object = {}) => ({
    ...emptyWorkstream({
      threadId: ThreadId.make(id),
      projectId: ProjectId.make("p"),
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      at,
    }),
    role: DOCUMENT_QUERY_ROLE,
    forkFromThreadId: author,
    documentQuery: { filePath, revision, questions: [], promotions: [] },
    ...extra,
  });
  const rows = [
    query("old", "aaa"),
    query("live", "bbb"),
    query("done", "bbb", { outcome: "done" }),
    query("archived", "ccc", { archivedAt: at }),
    query("other-file", "aaa", {
      documentQuery: { filePath: "x.mdx", revision: "aaa", questions: [], promotions: [] },
    }),
    query("other-author", "aaa", { forkFromThreadId: ThreadId.make("someone") }),
  ];
  const key = { authorThreadId: author, filePath, revision: "bbb" };
  assert.equal(reusableQueryThread(rows, key)?.threadId, "live");
  assert.deepEqual(
    supersededQueryThreads(rows, key).map((r) => r.threadId),
    ["old"],
  );
  assert.isNull(reusableQueryThread(rows, { ...key, revision: "ddd" }));
  assert.deepEqual(
    supersededQueryThreads(rows, { ...key, revision: "ddd" }).map((r) => r.threadId),
    ["old", "live"],
  );
  // The brief's machine-readable question survives a `-->` in the human's text.
  const tricky = ask(author, "does --> close it?");
  assert.deepEqual(
    Option.getOrThrow(parseDocumentQueryBrief(buildDocumentQueryBrief("overlay", tricky))),
    tricky,
  );
});

it.layer(TestLayer)("Query threads", (it) => {
  it.effect("a question forks the idle author; a second reuses it; a rewrite supersedes it", () =>
    Effect.gen(function* () {
      const author = ThreadId.make("query-author");
      yield* seedThread({ threadId: author });
      yield* seedRunningRun({ threadId: author, driver: pi });
      yield* completeSeededRun({ threadId: author });
      documentContents = "# Plan v1";

      const first = yield* askDocumentQuery(ask(author, "Why in-process?"));
      assert.isTrue(first.created);
      const query = yield* row(first.queryThreadId);
      assert.deepInclude(query, {
        role: DOCUMENT_QUERY_ROLE,
        parentThreadId: null,
        goalId: null,
        forkFromThreadId: author,
      });
      assert.equal(query.documentQuery?.filePath, filePath);
      assert.lengthOf(query.documentQuery?.revision ?? "", 12);
      assert.deepInclude((yield* forksOf(first.queryThreadId))[0], {
        type: "fork",
        sourceThreadId: author,
      });
      // ONE first message: the overlay, then the question as the human's, so the question is
      // the thread's first turn and nothing invites a reply to the overlay alone.
      const sent = yield* messagesOf(first.queryThreadId);
      assert.lengthOf(sent, 1);
      const question = sent[0];
      assert.equal(question?.id, `message:server:loom:query:${first.queryThreadId}:1`);
      assert.equal(question?.loom?.humanAuthored, true);
      assert.isUndefined(question?.loom?.origin);
      const split = splitDocumentQueryKickoff(question?.id ?? "", question?.text ?? "");
      assert.equal(split?.overlay, buildDocumentQueryOverlay({ filePath, authorThreadId: author }));
      assert.match(
        split?.question ?? "",
        /^\[plan\.mdx §2\]\(t3-context:\/\/v1\/review-comment\/.+\) Why in-process\?$/,
      );
      assert.deepInclude(question?.context?.records[0], { kind: "review-comment", filePath });
      assert.equal(query.documentQuery?.questions[0]?.messageId, question?.id);

      const second = yield* askDocumentQuery(ask(author, "And the reads?"));
      assert.deepEqual([second.created, second.queryThreadId], [false, first.queryThreadId]);
      assert.lengthOf((yield* row(first.queryThreadId)).documentQuery?.questions ?? [], 2);
      const reused = (yield* messagesOf(first.queryThreadId)).find(
        (m) => m.id === `message:server:loom:query:${first.queryThreadId}:2`,
      );
      // A later question is the question alone.
      assert.match(reused?.text ?? "", /^\[plan\.mdx §2\]\(.+\) And the reads\?$/);

      documentContents = "# Plan v2";
      const third = yield* askDocumentQuery(ask(author, "Still true?"));
      assert.isTrue(third.created);
      assert.notEqual(third.queryThreadId, first.queryThreadId);
      const superseded = yield* row(first.queryThreadId);
      assert.equal(superseded.outcome, "done");
      assert.isNotNull(superseded.archivedAt);
    }),
  );

  it.effect(
    "a mid-turn author defers the fork until its run ends, then the fork and one first message",
    () =>
      Effect.gen(function* () {
        const author = ThreadId.make("query-busy-author");
        yield* seedThread({ threadId: author });
        yield* seedRunningRun({ threadId: author, driver: pi });
        documentContents = "# Busy plan";

        const { queryThreadId, created } = yield* askDocumentQuery(ask(author, "Why?"));
        assert.isTrue(created);
        assert.deepInclude(yield* row(queryThreadId), {
          kickoffAt: null,
          forkFromThreadId: author,
        });
        assert.lengthOf((yield* row(queryThreadId)).documentQuery?.questions ?? [], 1);
        assert.lengthOf(yield* forksOf(queryThreadId), 0);
        assert.lengthOf(yield* messagesOf(queryThreadId), 0);
        // A second question has no session to land in yet.
        const waiting = yield* Effect.flip(askDocumentQuery(ask(author, "And?")));
        assert.include(waiting.message, "still waiting");

        yield* settlePass; // the author is still running: still nothing
        assert.lengthOf(yield* messagesOf(queryThreadId), 0);

        yield* completeSeededRun({ threadId: author });
        yield* settlePass;
        assert.deepInclude((yield* forksOf(queryThreadId))[0], {
          type: "fork",
          sourceThreadId: author,
        });
        const sent = yield* messagesOf(queryThreadId);
        assert.deepEqual(
          sent.map((m) => [m.loom?.origin ?? "user", m.id]),
          [["user", `message:server:loom:query:${queryThreadId}:1`]],
        );
        const split = splitDocumentQueryKickoff(sent[0]?.id ?? "", sent[0]?.text ?? "");
        assert.equal(
          split?.overlay,
          buildDocumentQueryOverlay({ filePath, authorThreadId: author }),
        );
        assert.match(split?.question ?? "", / Why\?$/);

        yield* settlePass; // idempotent: nothing re-sent
        assert.lengthOf(yield* messagesOf(queryThreadId), 1);
        assert.deepEqual((yield* row(queryThreadId)).attention, []);
      }),
  );
  it.effect(
    "Promote queues a human turn; the tool, refused off a query thread, anchors to its question",
    () =>
      Effect.gen(function* () {
        const author = ThreadId.make("query-promote-author");
        yield* seedThread({ threadId: author });
        yield* seedRunningRun({ threadId: author, driver: pi });
        yield* completeSeededRun({ threadId: author });
        documentContents = "# Promote plan";
        const first = yield* askDocumentQuery(ask(author, "Why in-process?"));
        const second = yield* askDocumentQuery(ask(author, "And the reads?"));
        const caller = (threadId: ThreadId) => ({ threadId }) as WorkstreamCaller;

        // The RPC: an unknown exchange is refused; a known one queues the human's promote turn.
        const stray = yield* Effect.flip(
          promoteDocumentQuery({
            queryThreadId: first.queryThreadId,
            exchangeAt: "2000-01-01T00:00:00.000Z",
          }),
        );
        assert.include(stray.message, "not a question asked in this query thread");
        yield* promoteDocumentQuery({
          queryThreadId: first.queryThreadId,
          exchangeAt: second.askedAt,
        });
        const turn = (yield* messagesOf(first.queryThreadId)).find((m) =>
          m.id.startsWith("message:server:loom:query-promote:"),
        );
        assert.equal(turn?.loom?.humanAuthored, true);
        assert.include(turn?.text ?? "", `exchangeAt ${second.askedAt}`);

        // The tool: any thread but a query thread is refused, and nothing is recorded.
        const refused = yield* Effect.flip(
          documentQueryPromote({ text: "x", exchangeAt: second.askedAt }, caller(author)),
        );
        assert.include(refused.message, "Only a query thread can promote");
        const wrong = yield* Effect.flip(
          documentQueryPromote(
            { text: "x", exchangeAt: "2000-01-01T00:00:00.000Z" },
            caller(first.queryThreadId),
          ),
        );
        assert.include(wrong.message, "matches no question");

        // The anchor, passage and section come from the named question, not the model.
        const reply = yield* documentQueryPromote(
          { text: "  State the snapshot caveat in §2.  ", exchangeAt: second.askedAt },
          caller(first.queryThreadId),
        );
        assert.equal(
          reply,
          "Recorded. The comment will appear in the author's composer; the human sends it.",
        );
        const query = yield* row(first.queryThreadId);
        const asked = query.documentQuery?.questions[1];
        const [promotion] = query.documentQuery?.promotions ?? [];
        assert.equal(promotion?.exchangeAt, second.askedAt);
        assert.deepEqual(promotion?.comment, {
          text: "State the snapshot caveat in §2.",
          anchor: asked!.anchor,
          quotedText: asked!.quotedText,
          sectionId: "s2",
          sectionTitle: "2. One reader lane",
          rangeLabel: "promoted",
        });
        // Promoting never closes the thread: a second exchange can be promoted too.
        assert.deepInclude(query, { outcome: null, archivedAt: null });
      }),
  );
});
