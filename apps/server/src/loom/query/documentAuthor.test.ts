/**
 * What the author lookup tells the document header and the link follow
 * (plans/document-comments-to-author/plan.mdx §2): an archived author, an author whose copy is
 * another file, threads that edited the document after it was signed, and a reviewer signer
 * reached by fall-through.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import {
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
  writeEvents,
} from "../testkit/loomOrchestratorLayer.ts";
import { lookupDocumentQueryAuthor } from "./documentAuthor.ts";

let documentContents = "";

const TestLayer = Layer.mergeAll(
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
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-author-" }),
).pipe(
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const pi = ProviderDriverKind.make("pi");
const filePath = "plans/read-lane/plan.mdx";
const absolute = `/workspace/project:loom-test/${filePath}`;
const signedAt = "2026-10-05T00:00:00.000Z";
const signed = (entries: ReadonlyArray<readonly [id: string, role: string]>) =>
  [
    "---",
    "manager_sessions:",
    ...entries.flatMap(([id, role]) => [
      `  - id: ${id}`,
      `    role: ${role}`,
      `    authored_at: ${signedAt}`,
    ]),
    "---",
    "# Plan",
  ].join("\n");

/** A finished pi run whose session file is `session`, so a signature maps to the thread. */
const signs = (threadId: ThreadId, session: string) =>
  Effect.andThen(
    seedRunningRun({
      threadId,
      driver: pi,
      nativeThreadId: `/sessions/--wt--/2026-10-01T00-00-00-000Z_${session}.jsonl`,
    }),
    completeSeededRun({ threadId }),
  );

let edits = 0;
/** A recorded edit tool call by `threadId` on `fileName`, started at `startedAt`. */
const edit = (threadId: ThreadId, fileName: string, startedAt: string) =>
  Effect.flatMap(DateTime.now, (now) => {
    const ids = seededRunIds(threadId);
    const at = DateTime.makeUnsafe(startedAt);
    return writeEvents([
      {
        id: EventId.make(`event:author-test:${++edits}`),
        threadId,
        runId: ids.runId,
        occurredAt: now,
        type: "turn-item.updated",
        payload: {
          id: TurnItemId.make(`turn-item:${threadId}:edit-${edits}`),
          threadId,
          runId: ids.runId,
          nodeId: ids.nodeId,
          providerThreadId: ids.providerThreadId,
          providerTurnId: ids.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 100 + edits,
          status: "completed",
          title: "edit",
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "file_change",
          fileName,
        },
      } as unknown as OrchestrationV2DomainEvent,
    ]);
  });

it.layer(TestLayer)("document author lookup", (it) => {
  it.effect("lists the threads that edited the document after it was signed", () =>
    Effect.gen(function* () {
      const root = ThreadId.make("editors-root");
      const author = ThreadId.make("editors-author");
      const reviser = ThreadId.make("editors-reviser");
      const earlier = ThreadId.make("editors-earlier");
      yield* seedThread({ threadId: root });
      yield* spawnChild({ parentThreadId: root, threadId: author, role: "planner" });
      yield* spawnChild({ parentThreadId: root, threadId: reviser });
      yield* spawnChild({ parentThreadId: root, threadId: earlier });
      const session = "01a15c20-aaaa-7192-ba4d-ee2415c0b3e4";
      yield* signs(author, session);
      for (const thread of [root, reviser, earlier]) yield* seedRunningRun({ threadId: thread });
      documentContents = signed([[session, "plan"]]);

      yield* edit(earlier, filePath, "2026-10-04T00:00:00.000Z");
      yield* edit(author, absolute, "2026-10-06T00:00:00.000Z");
      yield* edit(root, absolute, "2026-10-07T00:00:00.000Z");
      yield* edit(reviser, filePath, "2026-10-06T00:00:00.000Z");
      yield* edit(reviser, "plans/other.mdx", "2026-10-06T00:00:00.000Z");

      const result = yield* lookupDocumentQueryAuthor({ sourceThreadId: root, filePath });
      assert.deepInclude(result, {
        authorThreadId: author,
        authorSource: "signature",
        authoringSignature: true,
        authorArchived: false,
        sameFile: true,
      });
      // Relative and absolute names both match; the author and a pre-signature edit do not.
      assert.deepEqual(
        result.laterEditors.map((editor) => editor.threadId),
        [reviser, root],
      );
    }),
  );

  it.effect("reports an archived author, and a copy in another workspace as another file", () =>
    Effect.gen(function* () {
      const viewer = ThreadId.make("archive-viewer");
      const archived = ThreadId.make("archive-author");
      const elsewhere = ThreadId.make("elsewhere-author");
      yield* seedThread({ threadId: viewer });
      yield* seedThread({ threadId: archived });
      yield* seedThread({ threadId: elsewhere, projectId: ProjectId.make("project:other") });
      const archivedSession = "01a15c20-bbbb-7192-ba4d-ee2415c0b3e4";
      const elsewhereSession = "01a15c20-cccc-7192-ba4d-ee2415c0b3e4";
      yield* signs(archived, archivedSession);
      yield* signs(elsewhere, elsewhereSession);
      yield* dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-author"),
        threadId: archived,
      });

      documentContents = signed([[archivedSession, "plan"]]);
      assert.deepInclude(yield* lookupDocumentQueryAuthor({ sourceThreadId: viewer, filePath }), {
        authorThreadId: archived,
        authorArchived: true,
        sameFile: true,
      });

      documentContents = signed([[elsewhereSession, "plan"]]);
      assert.deepInclude(yield* lookupDocumentQueryAuthor({ sourceThreadId: viewer, filePath }), {
        authorThreadId: elsewhere,
        authorArchived: false,
        sameFile: false,
        filePath,
      });
      // Opened by absolute path inside the author's own workspace: the same file.
      assert.deepInclude(
        yield* lookupDocumentQueryAuthor({
          sourceThreadId: viewer,
          filePath: `/workspace/project:other/${filePath}`,
        }),
        { authorThreadId: elsewhere, sameFile: true, filePath },
      );
    }),
  );

  it.effect("a reviewer reached because every authoring signer is gone is not an author", () =>
    Effect.gen(function* () {
      const viewer = ThreadId.make("reviewer-viewer");
      const reviewer = ThreadId.make("reviewer-signer");
      yield* seedThread({ threadId: viewer });
      yield* seedThread({ threadId: reviewer });
      const reviewerSession = "01a15c20-dddd-7192-ba4d-ee2415c0b3e4";
      yield* signs(reviewer, reviewerSession);
      documentContents = signed([
        ["01a15c20-eeee-7192-ba4d-ee2415c0b3e4", "plan"],
        [reviewerSession, "reviewer"],
      ]);
      assert.deepInclude(yield* lookupDocumentQueryAuthor({ sourceThreadId: viewer, filePath }), {
        authorThreadId: reviewer,
        authorSource: "signature",
        authoringSignature: false,
      });
    }),
  );
});
