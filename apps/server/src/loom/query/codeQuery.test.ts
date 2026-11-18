/**
 * Code query threads on the real orchestrator and a real temp repository (plans/code-query/plan.mdx
 * §7, slice 2): the author is named from the commit or refused; one live query thread per author
 * run; a mid-turn author defers the fork; asking and promoting leave the author exactly as it was.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the fixture repo is built with plain git and fs
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type CodeQueryInput,
  CommandId,
  DOCUMENT_QUERY_ROLE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { splitDocumentQueryKickoff } from "@t3tools/shared/documentQuery.loom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import type { WorkstreamCaller } from "../../mcp/toolkits/workstream/authorisation.ts";
import { documentQueryPromote } from "../../mcp/toolkits/workstream/handlers/documentQuery.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  HandoffDrafterReactor,
  HandoffDrafterReactorServiceLive,
} from "../handoff/HandoffDrafterReactor.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import * as ReviewAuthorship from "../review/ReviewAuthorship.ts";
import {
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  seedThread,
  testModelSelection,
} from "../testkit/loomOrchestratorLayer.ts";
import { askCodeQuery } from "./codeQuery.ts";
import { buildCodeQueryOverlay, buildCodeQueryQuestion } from "./codeQueryOverlay.ts";
import { promoteDocumentQuery } from "./documentQuery.ts";

// The agent git shim adds this session's own trailer when LOOM_THREAD_ID is set; clear it.
const GIT_ENV = { ...process.env, LOOM_THREAD_ID: "", GIT_COMMITTER_NAME: "t" };
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const commitLines = (
  cwd: string,
  lines: ReadonlyArray<string>,
  subject: string,
  trailers: ReadonlyArray<string>,
) => {
  NodeFS.writeFileSync(NodePath.join(cwd, "app.ts"), `${lines.join("\n")}\n`);
  git(cwd, "add", "-A");
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      subject,
      ...trailers.flatMap((thread) => ["--trailer", `Loom-Thread: ${thread}`]),
    ],
    { cwd, env: { ...GIT_ENV, GIT_AUTHOR_NAME: "Loom agent" } },
  );
  return git(cwd, "rev-parse", "HEAD");
};

const TestLayer = Layer.mergeAll(
  HandoffDrafterReactorServiceLive,
  ReviewAuthorship.layer.pipe(
    Layer.provideMerge(ProjectStore.layer),
    Layer.provideMerge(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-code-query-git-" })),
      ),
    ),
  ),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-code-query-" }),
).pipe(
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const pi = ProviderDriverKind.make("pi");
const row = (threadId: ThreadId) =>
  Effect.flatMap(LoomStoreV2, (store) => Effect.map(store.getWorkstream(threadId), (r) => r!));
const projectionOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (o) => o.getThreadProjection(threadId));
const messagesOf = (threadId: ThreadId) =>
  Effect.map(projectionOf(threadId), (projection) => projection.messages);
const forksOf = (threadId: ThreadId) =>
  Effect.map(
    Effect.flatMap(Orchestrator.OrchestratorV2, (o) =>
      o.getThreadRecords(threadId, ["contextTransfers"]),
    ),
    (records) => records.contextTransfers,
  );
/** What Query must never change on the author: its runs, its messages and its Loom sidecar. */
const authorState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projection = yield* projectionOf(threadId);
    return {
      thread: projection.thread,
      runs: projection.runs,
      messages: projection.messages,
      row: yield* row(threadId),
    };
  });
const settlePass = Effect.flatMap(HandoffDrafterReactor, (reactor) => reactor.runPass);

/** A reviewing thread on a fresh repository whose branch `feature` is checked out. */
const reviewRepo = Effect.fn("test.reviewRepo")(function* (name: string) {
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-code-query-"));
  git(worktree, "init", "-q", "-b", "main");
  const base = commitLines(worktree, ["a", "b", "c", "d", "e"], "base", []);
  git(worktree, "checkout", "-q", "-b", "feature");
  const projectId = ProjectId.make(`project:code-query-${name}`);
  yield* (yield* ProjectService.ProjectService).create({
    commandId: CommandId.make(`command:code-query-project-${name}`),
    projectId,
    title: "Code query test project",
    workspaceRoot: worktree,
  });
  const reviewThreadId = ThreadId.make(`thread:code-query-review-${name}`);
  yield* dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:code-query-review-${name}`),
    threadId: reviewThreadId,
    projectId,
    title: "Reviewer",
    modelSelection: testModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: worktree,
  });
  return { worktree, base, reviewThreadId };
});

/** Question input as the card would send it for added line `line` of app.ts. */
const asking = (
  reviewThreadId: ThreadId,
  commitSha: string,
  ownerShas: ReadonlyArray<string>,
  line: number,
  question: string,
): CodeQueryInput => ({
  reviewThreadId,
  baseRef: "main",
  commitSha,
  ownerShas,
  filePath: "app.ts",
  startLine: line,
  endLine: line,
  selection: { start: line, side: "additions", end: line, endSide: "additions" },
  startIndex: line,
  endIndex: line,
  rangeLabel: `+${line}`,
  sectionId: "loom-file-change",
  sectionTitle: "Changes",
  diff: `@@ -${line},1 +${line},1 @@\n-x\n+line ${line}`,
  question,
});

it.layer(TestLayer)("Code query threads", (it) => {
  it.effect(
    "a question forks the idle author; a second reuses it; Promote records; the author is untouched; its next run supersedes",
    () =>
      Effect.gen(function* () {
        const { worktree, reviewThreadId } = yield* reviewRepo("main");
        const coder = ThreadId.make("code-query-coder");
        const fixer = ThreadId.make("code-query-fixer");
        // A role gives the author a sidecar row, as every real coder has, for the snapshot to compare.
        yield* seedThread({ threadId: coder, title: "CSV coder", role: "coder" });
        yield* seedRunningRun({ threadId: coder, driver: pi });
        yield* completeSeededRun({ threadId: coder });
        yield* seedThread({ threadId: fixer, title: "Fixer" });
        const byCoder = commitLines(
          worktree,
          ["a", "B1", "c", "D1", "e"],
          "feat: the coder's lines",
          [coder],
        );
        const byFixer = commitLines(worktree, ["a", "B2", "c", "D1", "e"], "fix: rename B", [
          fixer,
        ]);
        const before = yield* authorState(coder);
        assert.isNotNull(before.row);

        const first = yield* askCodeQuery(asking(reviewThreadId, byCoder, [byCoder], 4, "Why D1?"));
        assert.deepInclude(first, { created: true, authorThreadId: coder });
        const query = yield* row(first.queryThreadId);
        assert.deepInclude(query, {
          role: DOCUMENT_QUERY_ROLE,
          parentThreadId: null,
          goalId: null,
          forkFromThreadId: coder,
          documentQuery: null,
        });
        assert.equal((yield* projectionOf(first.queryThreadId)).thread.title, "Query: CSV coder");
        assert.equal(query.codeQuery?.forkedAtRunId, seededRunIds(coder).runId);
        assert.deepInclude(query.codeQuery?.questions[0], {
          askedAt: first.askedAt,
          commitSha: byCoder,
          ownerShas: [byCoder],
          filePath: "app.ts",
          startLine: 4,
          endLine: 4,
          sectionId: "loom-file-change",
          excerpt: "@@ -4,1 +4,1 @@\n-x\n+line 4",
        });
        assert.deepInclude((yield* forksOf(first.queryThreadId))[0], {
          type: "fork",
          sourceThreadId: coder,
        });
        // ONE first message, the human's: the overlay, then the lines' chip, the commit and the question.
        const sent = yield* messagesOf(first.queryThreadId);
        assert.lengthOf(sent, 1);
        const message = sent[0]!;
        assert.equal(message.id, `message:server:loom:query:${first.queryThreadId}:1`);
        assert.equal(message.loom?.humanAuthored, true);
        const record = message.context?.records[0];
        assert.deepInclude(record, {
          kind: "review-comment",
          filePath: "app.ts",
          rangeLabel: "+4",
          text: "",
          diff: "@@ -4,1 +4,1 @@\n-x\n+line 4",
          fenceLanguage: "diff",
        });
        const commit = { sha: byCoder, subject: "feat: the coder's lines", threadIds: [coder] };
        assert.deepEqual(splitDocumentQueryKickoff(message.id, message.text), {
          overlay: buildCodeQueryOverlay({ authorThreadId: coder }),
          question: buildCodeQueryQuestion({
            reference: formatComposerContextReference(record!),
            question: "Why D1?",
            commit,
            owners: [commit],
          }),
        });
        assert.equal(query.codeQuery?.questions[0]?.messageId, message.id);

        // Asked from the earlier-author row of lines the fixer rewrote: the coder's same thread,
        // and the sentence says the lines are no longer as the coder wrote them.
        const second = yield* askCodeQuery(
          asking(reviewThreadId, byCoder, [byFixer], 2, "Why B1?"),
        );
        assert.deepEqual([second.created, second.queryThreadId], [false, first.queryThreadId]);
        const reused = (yield* messagesOf(first.queryThreadId)).find(
          (m) => m.id === `message:server:loom:query:${first.queryThreadId}:2`,
        );
        assert.match(
          reused?.text ?? "",
          /^\[app\.ts \+2\]\(t3-context:\/\/v1\/review-comment\/.+\) An earlier version of these lines is from your commit .+ They have since been rewritten by commit .+"fix: rename B"/,
        );
        assert.lengthOf((yield* row(first.queryThreadId)).codeQuery?.questions ?? [], 2);

        // Promote: the RPC queues the human's turn; the tool records the words, the lines stay the
        // question's; the tool still refuses a thread that is not a query thread.
        yield* promoteDocumentQuery({
          queryThreadId: first.queryThreadId,
          exchangeAt: second.askedAt,
        });
        assert.isDefined(
          (yield* messagesOf(first.queryThreadId)).find((m) =>
            m.id.startsWith("message:server:loom:query-promote:"),
          ),
        );
        const caller = (threadId: ThreadId) => ({ threadId }) as WorkstreamCaller;
        const refused = yield* Effect.flip(
          documentQueryPromote({ text: "x", exchangeAt: second.askedAt }, caller(coder)),
        );
        assert.include(refused.message, "Only a query thread can promote");
        yield* documentQueryPromote(
          { text: "  Name it B, as the importer reads.  ", exchangeAt: second.askedAt },
          caller(first.queryThreadId),
        );
        const promoted = yield* row(first.queryThreadId);
        assert.deepInclude(promoted.codeQuery?.promotions[0], {
          exchangeAt: second.askedAt,
          text: "Name it B, as the importer reads.",
        });
        assert.deepInclude(promoted, { outcome: null, archivedAt: null });

        // A query thread about code takes no document question.
        const crossed = yield* Effect.flip(
          dispatch({
            type: "thread.document-query.ask",
            commandId: CommandId.make("command:code-query-crossed"),
            threadId: first.queryThreadId,
            createdAt: first.askedAt,
            filePath: "plan.mdx",
            revision: "abc",
            authorSource: "signature",
            question: {
              messageId: MessageId.make("message:code-query-crossed"),
              askedAt: first.askedAt,
              anchor: { textQuote: "x" },
              quotedText: "x",
              sectionTitle: "x",
            },
          }),
        );
        assert.include(String((crossed as { cause?: unknown }).cause), "is about code");

        // The must-not: asking and promoting spent no turn of the author and changed nothing in it.
        assert.deepEqual(yield* authorState(coder), before);

        // The author runs again: the next question forks afresh and settles the old query thread.
        yield* seedRunningRun({ threadId: coder, driver: pi, ordinal: 2 });
        yield* completeSeededRun({ threadId: coder, ordinal: 2 });
        const third = yield* askCodeQuery(
          asking(reviewThreadId, byCoder, [byCoder], 4, "Still D1?"),
        );
        assert.isTrue(third.created);
        assert.notEqual(third.queryThreadId, first.queryThreadId);
        assert.equal(
          (yield* row(third.queryThreadId)).codeQuery?.forkedAtRunId,
          seededRunIds(coder, 2).runId,
        );
        assert.deepInclude(yield* row(first.queryThreadId), { outcome: "done" });
        assert.isNotNull((yield* row(first.queryThreadId)).archivedAt);
      }),
  );

  it.effect(
    "a commit off the branch, with two trailers, with none or naming an unknown thread is refused",
    () =>
      Effect.gen(function* () {
        const { worktree, base, reviewThreadId } = yield* reviewRepo("refusals");
        const one = ThreadId.make("code-query-one");
        const other = ThreadId.make("code-query-other");
        yield* seedThread({ threadId: one });
        yield* seedThread({ threadId: other });
        const amended = commitLines(worktree, ["a", "B", "c", "d", "e"], "amended", [one, other]);
        const bare = commitLines(worktree, ["a", "B", "C", "d", "e"], "no trailer", []);
        const unknown = commitLines(worktree, ["a", "B", "C", "D", "e"], "unknown", [
          "thread:not-held-here",
        ]);
        const refusal = (commitSha: string) =>
          Effect.map(
            Effect.flip(askCodeQuery(asking(reviewThreadId, commitSha, [commitSha], 2, "Why?"))),
            (error) => error.message,
          );
        assert.include(yield* refusal(base), "is not on this branch's diff");
        assert.include(yield* refusal(amended), "names 2 threads");
        assert.include(yield* refusal(bare), "carries no Loom-Thread trailer");
        assert.include(yield* refusal(unknown), "which this server does not hold");
        // An owner the branch no longer has: the diff the lines were selected in is stale.
        const stale = yield* Effect.flip(
          askCodeQuery(asking(reviewThreadId, amended, [base], 2, "Why?")),
        );
        assert.include(stale.message, "The branch has changed");
      }),
  );

  it.effect("a mid-turn author defers the fork; the reactor launches it once its run ends", () =>
    Effect.gen(function* () {
      const { worktree, reviewThreadId } = yield* reviewRepo("busy");
      const author = ThreadId.make("code-query-busy-author");
      yield* seedThread({ threadId: author });
      yield* seedRunningRun({ threadId: author, driver: pi });
      const sha = commitLines(worktree, ["a", "B", "c", "d", "e"], "busy work", [author]);

      const { queryThreadId, created } = yield* askCodeQuery(
        asking(reviewThreadId, sha, [sha], 2, "Why B?"),
      );
      assert.isTrue(created);
      assert.deepInclude(yield* row(queryThreadId), { kickoffAt: null, forkFromThreadId: author });
      assert.lengthOf((yield* row(queryThreadId)).codeQuery?.questions ?? [], 1);
      assert.lengthOf(yield* forksOf(queryThreadId), 0);
      assert.lengthOf(yield* messagesOf(queryThreadId), 0);
      const waiting = yield* Effect.flip(
        askCodeQuery(asking(reviewThreadId, sha, [sha], 2, "And?")),
      );
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
        sent.map((m) => m.id),
        [`message:server:loom:query:${queryThreadId}:1`],
      );
      const split = splitDocumentQueryKickoff(sent[0]!.id, sent[0]!.text);
      assert.equal(split?.overlay, buildCodeQueryOverlay({ authorThreadId: author }));
      assert.match(split?.question ?? "", /These lines are from your commit .+\n\nWhy B\?$/);

      yield* settlePass; // idempotent: nothing re-sent
      assert.lengthOf(yield* messagesOf(queryThreadId), 1);
      assert.deepEqual((yield* row(queryThreadId)).attention, []);
    }),
  );
});
