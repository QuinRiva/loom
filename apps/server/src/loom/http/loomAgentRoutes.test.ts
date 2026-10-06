/**
 * The `/loom/agent` routes over HTTP on the real orchestrator, with
 * credentials from the real `McpSessionRegistry`: the session profile's
 * `humanEngaged` reads only seam 14's stamp, a child's profile drops
 * `mcp__t3-code__ask_user_question`, ask + wait deliver an answer, and a credential without
 * `workstream` is refused.
 */
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  seedRunningRun,
  seedThread,
  spawnChild,
} from "../testkit/loomOrchestratorLayer.ts";
import { reactToAskEvent } from "../userInput/askUserQuestion.ts";
import { LoomAgentRoutesLive } from "./loomAgentRoutes.ts";

const ASK = "mcp__t3-code__ask_user_question";

const TestLayer = HttpRouter.serve(LoomAgentRoutesLive, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(McpSessionRegistry.layer),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed("environment-loom-agent" as never),
    }),
  ),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-agent-" })),
  Layer.provideMerge(NodeServices.layer),
);

const credential = (threadId: ThreadId, capabilities: ReadonlyArray<McpCapability>) =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(capabilities),
    });
    return issued.config.authorizationHeader;
  });

const call = (authorization: string, method: "GET" | "POST", path: string, body?: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `/loom/agent${path}`;
    const response = yield* (
      method === "GET"
        ? client.get(url, { headers: { authorization } })
        : client.post(url, {
            headers: { authorization },
            body: HttpBody.jsonUnsafe(body),
          })
    ).pipe(Effect.orDie);
    return { status: response.status, body: (yield* response.json.pipe(Effect.orDie)) as any };
  });

/** A user-role message as committed, with the `loom` stamp the dispatcher would have set. */
const seedUserMessage = (threadId: ThreadId, id: string, humanAuthored: boolean) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make(`event:${id}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: MessageId.make(id),
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: id,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: humanAuthored ? "web" : "server",
            loom: { humanAuthored },
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  });

it.layer(TestLayer)("Loom agent routes", (it) => {
  it.effect("humanEngaged counts only stamped human messages, never a usage-limit resume", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ threadId: "routes-root" as ThreadId });
      const auth = yield* credential(threadId, ["workstream"]);
      // Upstream's limit-resume is createdBy user; the stamp says it is not a person.
      yield* seedUserMessage(threadId, "message:routes:limit-resume", false);
      const before = yield* call(auth, "GET", "/session-profile");
      assert.equal(before.status, 200);
      assert.isFalse(before.body.humanEngaged);
      assert.isFalse(before.body.hasParent);
      assert.include(before.body.activeTools, ASK); // the root orchestrator keeps human-input resident
      assert.include(before.body.denyList, "mcp__t3-code__delegate_task");
      assert.match(before.body.promptDebugPath, /prompt-debug\/routes-root\.md$/);
      // The extension's prompt-debug part writes there with plain fs: the directory must exist.
      assert.isTrue(
        yield* (yield* FileSystem.FileSystem).exists(
          before.body.promptDebugPath.replace(/\/routes-root\.md$/, ""),
        ),
      );

      yield* seedUserMessage(threadId, "message:routes:human", true);
      assert.isTrue((yield* call(auth, "GET", "/session-profile")).body.humanEngaged);
    }),
  );

  it.effect(
    "a child nobody has written to does not keep mcp__t3-code__ask_user_question resident",
    () =>
      Effect.gen(function* () {
        const { threadId: parent } = yield* seedThread({ threadId: "routes-parent" as ThreadId });
        const child = "routes-child" as ThreadId;
        yield* spawnChild({ parentThreadId: parent, threadId: child, role: "orchestrator" });
        const profile = (yield* call(
          yield* credential(child, ["workstream"]),
          "GET",
          "/session-profile",
        )).body;
        assert.isTrue(profile.hasParent);
        assert.isFalse(profile.humanEngaged);
        assert.notInclude(profile.activeTools, ASK);
        assert.include(profile.activeTools, "mcp__t3-code__workstream_spawn");
      }),
  );

  it.effect("ask opens the question and wait returns the answer", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ threadId: "routes-ask" as ThreadId });
      yield* seedRunningRun({ threadId });
      const auth = yield* credential(threadId, ["workstream"]);
      const opened = yield* call(auth, "POST", "/user-input/ask", {
        toolCallId: "call-1",
        questions: [
          {
            header: "Ship",
            question: "Ship it?",
            options: [
              { label: "Yes", description: "Merge." },
              { label: "No", description: "Hold." },
            ],
          },
        ],
      });
      assert.equal(opened.status, 200);
      const requestId = RuntimeRequestId.make(opened.body.requestId);

      const result = yield* dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("command:routes:respond"),
        threadId,
        requestId,
        answers: { q1: "No" },
      });
      yield* Effect.forEach(result.storedEvents, (stored) => reactToAskEvent(stored.event), {
        discard: true,
      });

      const waited = yield* call(auth, "GET", `/user-input/${encodeURIComponent(requestId)}/wait`);
      assert.deepEqual(waited.body, {
        pending: false,
        rendered: "The user answered:\n- Ship it?: No",
      });

      const invalid = yield* call(auth, "POST", "/user-input/ask", { questions: [] });
      assert.equal(invalid.status, 409);
      assert.include(invalid.body.message, "between 1 and 4 questions");
    }),
  );

  it.effect("a credential without workstream gets 403, none gets 401", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ threadId: "routes-denied" as ThreadId });
      const auth = yield* credential(threadId, ["orchestration", "pull-requests"]);
      for (const [method, path] of [
        ["GET", "/session-profile"],
        ["POST", "/user-input/ask"],
        ["GET", "/user-input/loom-ask%3Ax/wait"],
      ] as const) {
        assert.equal((yield* call(auth, method, path, {})).status, 403);
        assert.equal((yield* call("Bearer nope", method, path, {})).status, 401);
      }
    }),
  );
});
