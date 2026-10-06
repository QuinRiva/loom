/**
 * The withhold (P3-6): a credential carrying what `prepareMcpSession` issues a
 * Loom thread — `workstream` + `pull-requests` (pinned in
 * `ProviderSessionManager.test.ts`) — is denied upstream's orchestration tools
 * and served the PR toolkit and Loom's own.
 */
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import { LOOM_TEST_THREAD, mcpTestLayer, serveMcp } from "./mcpHttp.testkit.ts";

const PROJECT_ID = ProjectId.make("project-loom");

const thread = v2PullRequestThread({
  id: LOOM_TEST_THREAD,
  projectId: PROJECT_ID,
  title: "Shipper",
  modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "fable" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestUserMessageAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
});

it.effect("a Loom credential is denied delegate_task and t3_thread_send, and links a PR", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const mcp = yield* serveMcp(
      {
        orchestrator: {
          getThreadShell: (id) => Effect.succeed(id === LOOM_TEST_THREAD ? thread : null),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] };
            }),
        },
        projects: {
          getShell: () =>
            Effect.succeed(
              Option.some({
                id: PROJECT_ID,
                title: "Loom",
                workspaceRoot: "/workspace/loom",
                defaultModelSelection: null,
                scripts: [],
                repositoryIdentity: null,
                createdAt: "2026-10-01T00:00:00.000Z",
                updatedAt: "2026-10-01T00:00:00.000Z",
              }),
            ),
        },
      },
      { threadId: LOOM_TEST_THREAD, capabilities: ["workstream", "pull-requests"] },
    );

    for (const [name, args] of [
      ["delegate_task", { task: "do it" }],
      ["t3_thread_send", { threadId: "other", message: "hi" }],
    ] as const) {
      const denied = yield* mcp.callTool(name, args);
      expect(denied.content.map((block) => block.text).join("\n"), name).toContain(
        "capability_denied",
      );
    }
    const worktree = yield* mcp.callTool("t3_worktree_status", {});
    expect(worktree.isError, "t3_worktree_status").toBe(true);

    const linked = yield* mcp.callTool("link_pull_request", {
      url: "https://github.com/QuinRiva/loom/pull/42",
    });
    expect(linked.isError ?? false).toBe(false);
    expect(dispatched).toMatchObject([
      { type: "thread.pull-request.link", threadId: LOOM_TEST_THREAD, number: 42 },
    ]);

    const loom = yield* mcp.callTool("workstream_submit", { markdown: "report" });
    expect(loom.content).toEqual([
      { type: "text", text: "workstream_submit is not ported in 3a-1." },
    ]);
  }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
);
