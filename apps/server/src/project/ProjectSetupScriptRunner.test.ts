import * as NodeServices from "@effect/platform-node/NodeServices"; // loom: breadcrumb
import { describe, expect, it, vi } from "@effect/vitest";
import { type OrchestrationProject, ProjectId, type TerminalEvent } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import {
  WORKTREE_SETUP_STATE_FILE,
  type WorktreeSetupState,
} from "./ProjectSetupScriptRunner.loom.ts"; // loom: breadcrumb

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);

const makeProject = (
  scripts: OrchestrationProject["scripts"],
  workspaceRoot = "/repo/project",
): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getUserInputActivity: () => Effect.die("unused"),
    listActivitiesByKind: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getLeanShellSnapshot: () => Effect.die("unused"),
    getBriefNeededAttentionParentIds: () => Effect.succeed(new Set()),
    getArchivedFannedInWorktreeChildren: () => Effect.succeed([]),
    getReferencedWorktreePaths: () => Effect.succeed(new Set()),
    listThreadsWithPullRequests: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShells: () => Effect.die("unused"),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getGoalShellById: () => Effect.die("unused in this test"),
    getLiveSubtreeSessionLiveness: () => Effect.die("unused in this test"),
    getThreadObligations: () => Effect.die("unused in this test"),
    getGoalById: () => Effect.die("unused in this test"),
    listGoalSlugsByProjectId: () => Effect.die("unused in this test"),
    listActiveProjectRefs: () => Effect.die("unused in this test"),
    getPendingTurnStartThreadIds: () => Effect.die("unused in this test"),
    listPendingPeerMessages: () => Effect.die("unused in this test"),
    getActivityFreshnessByThreadId: () => Effect.die("unused in this test"),
    getOpenUserInputRequestIdsByThreadId: () => Effect.die("unused in this test"),
    getRecentToolActivityByThreadId: () => Effect.die("unused in this test"),
    getThreadProgressSignal: () => Effect.die("unused in this test"),
    getInFlightToolByThreadId: () => Effect.die("unused in this test"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getTurnStartMessage: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadActivitiesPage: () => Effect.die("unused"),
    getThreadLifecycle: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
  });

type TerminalOverrides = Pick<TerminalManager.TerminalManager["Service"], "open" | "write"> &
  Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe" | "closeIdle">>;

const makeTerminalManagerLayer = (overrides: TerminalOverrides) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    attachStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    closeIdle: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
    ...overrides,
  });

const testLayer = (
  project: OrchestrationProject,
  terminal: TerminalOverrides,
  settings = ServerSettings.layerTest(),
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(terminal)),
    Layer.provide(settings),
    Layer.provideMerge(NodeServices.layer), // loom: real FS for the breadcrumb
  );

describe("ProjectSetupScriptRunner", () => {
  it.effect("runs the inherited machine setup action in the checkout's worktree", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-default-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result).toMatchObject({ status: "started", scriptId: "default-setup" });
      expect(open).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      });
      expect(write).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        // loom: every run is observed (the breadcrumb), so the command is wrapped.
        data: expect.stringMatching(
          /^\( npm install\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
        ) as unknown as string,
      });
    }).pipe(
      Effect.provide(
        testLayer(
          makeProject([]),
          { open, write },
          ServerSettings.layerTest({
            defaultProjectScripts: [
              {
                id: "default-setup",
                name: "Setup",
                command: "npm install",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ],
          }),
        ),
      ),
      Effect.provideService(HostProcessPlatform, "linux"), // loom
      Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/bash" }), // loom
    );
  });

  it.effect("returns no-script when no setup script exists", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect(
    "opens the deterministic setup terminal with worktree env and writes the command",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
        });

        // loom: toMatchObject — every run is observed, so `completion` is present too.
        expect(result).toMatchObject({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "bun install",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          async: true,
        });
        expect(open).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          env: {
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          },
        });
        expect(write).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          // loom: every run is observed (the breadcrumb), so the command is wrapped.
          data: expect.stringMatching(
            /^\( bun install\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
          ) as unknown as string,
        });
      }).pipe(
        Effect.provide(testLayer(project, { open, write })),
        Effect.provideService(HostProcessPlatform, "linux"), // loom
        Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/bash" }), // loom
      );
    },
  );

  it.effect(
    "wraps the command with a completion sentinel and resolves the exit code from terminal output",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const writes: string[] = [];
      const write = vi.fn((input: { data: string }) =>
        Effect.sync(() => void writes.push(input.data)),
      );
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
        listener = next;
        return Effect.succeed(() => {
          listener = null;
        });
      });
      const closeIdle = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);
      const emit = (data: string) =>
        Effect.suspend(() =>
          listener
            ? listener({ threadId: "thread-1", terminalId: "setup-setup", type: "output", data })
            : Effect.void,
        );

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const seen: string[] = [];
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {
            onOutputLine: (line) => Effect.sync(() => void seen.push(line)),
          },
        });
        expect(result.status).toBe("started");
        if (result.status !== "started") return;
        expect(result.completion).toBeDefined();

        // The subscription is attached before the command is written.
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(writes).toHaveLength(1);
        // The block closes on its own line so a trailing comment in the
        // command cannot swallow the sentinel, and the sentinel carries a
        // per-run token so script output cannot spoof it.
        const written = writes[0] ?? "";
        const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
        expect(sentinel).toBeDefined();
        expect(written).toBe(`( bun install\r); printf '\\n${sentinel}%s\\n' "$?"\r`);

        // Output arrives in chunks; partial lines are buffered until a newline,
        // control sequences are stripped, and the echoed wrapper is hidden.
        yield* emit(`( bun install\r\n> ); printf '\\n${sentinel}%s\\n' "$?"\r\n`);
        yield* emit("\u001b[32mResolving");
        yield* emit(" deps\u001b[0m\r\n");
        // Progress redraws separated by bare carriage returns are their own lines.
        yield* emit("Progress: 1/3\rProgress: 2/3\rProgress: 3/3\r\nDone in 2s\r\n");
        // A spoofed sentinel from the script itself must not settle completion.
        yield* emit("__T3_SETUP_DONE__:0\r\n");
        yield* emit(`__T3_SETUP_DONE___${"0".repeat(32)}:0\r\n`);
        yield* emit(`${sentinel}3\r\n`);

        const completion = yield* result.completion!;
        expect(completion.exitCode).toBe(3);
        expect(seen).toEqual([
          "Resolving deps",
          "Progress: 1/3",
          "Progress: 2/3",
          "Progress: 3/3",
          "Done in 2s",
          "__T3_SETUP_DONE__:0",
          `__T3_SETUP_DONE___${"0".repeat(32)}:0`,
        ]);
        // The subscription is torn down once the sentinel arrives.
        expect(listener).toBeNull();
        // A failed run keeps its shell open for a look.
        expect(closeIdle).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(testLayer(project, { open, write, subscribe, closeIdle })),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/zsh" }),
      );
    },
  );

  it.effect("closes the idle setup shell after a clean exit", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    let written = "";
    const write = vi.fn((input: { data: string }) =>
      Effect.sync(() => void (written = input.data)),
    );
    let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
    const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
      listener = next;
      return Effect.succeed(() => {
        listener = null;
      });
    });
    const closeIdle = vi.fn(() => Effect.void);
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        observeCompletion: {},
      });
      if (result.status !== "started" || !result.completion) {
        return yield* Effect.die("expected an observed setup run");
      }
      const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
      yield* listener!({
        threadId: "thread-1",
        terminalId: "setup-setup",
        type: "output",
        data: `${sentinel}0\r\n`,
      });

      expect((yield* result.completion).exitCode).toBe(0);
      expect(closeIdle).toHaveBeenCalledWith({ threadId: "thread-1", terminalId: "setup-setup" });
    }).pipe(
      Effect.provide(testLayer(project, { open, write, subscribe, closeIdle })),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/zsh" }),
    );
  });

  it.effect("unsubscribes from terminal output when the command cannot be written", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() =>
      Effect.fail(
        new TerminalManager.TerminalCwdStatError({ cwd: "/repo/worktrees/a", cause: {} }),
      ),
    );
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => Effect.succeed(unsubscribe));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {},
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer(project, { open, write, subscribe })));
  });

  it.effect.each([
    {
      shell: "/usr/bin/fish",
      expected:
        /^begin\rbun install\rend; printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' \$status\r$/,
    },
    {
      shell: "/bin/bash",
      expected: /^\( bun install\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
    },
  ])("wraps the command for the $shell syntax", ({ shell, expected }) => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const writes: string[] = [];
    const write = vi.fn((input: { data: string }) =>
      Effect.sync(() => void writes.push(input.data)),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        observeCompletion: {},
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(expected);
    }).pipe(
      Effect.provide(testLayer(project, { open, write })),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { SHELL: shell }),
    );
  });

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open: () => Effect.fail(terminalError),
          write: () => Effect.die("unexpected write"),
        }),
      ),
    );
  });

  // loom: the worktree-readiness breadcrumb and the pnpm install rewrite.
  it.effect("uses pnpm frozen install when a pnpm worktree would otherwise run bun install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreePath = yield* fs.makeTempDirectory({ prefix: "t3-setup-pnpm-" });
      yield* fs.writeFileString(path.join(worktreePath, "pnpm-lock.yaml"), "");
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: worktreePath,
          worktreePath,
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn(() => Effect.void);
      const project = makeProject(
        [
          {
            id: "setup",
            name: "Setup",
            command: "bun install",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
        worktreePath,
      );

      yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: worktreePath,
          worktreePath,
        });

        expect(write).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: expect.stringMatching(
            /^\( pnpm install --frozen-lockfile\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
          ) as unknown as string,
        });
      }).pipe(
        Effect.provide(testLayer(project, { open, write })),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/bash" }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  /**
   * Starts a setup run in a real temp worktree whose `.git` file points at a
   * private gitdir (the linked-worktree shape), then settles it with `settle`:
   * a sentinel exit code, or `null` to leave the script hanging.
   */
  const runBreadcrumbScenario = (
    settle: number | null,
    afterStart: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "t3-setup-state-" });
      const worktreePath = path.join(dir, "worktree");
      const gitDir = path.join(dir, "gitdir");
      yield* fs.makeDirectory(worktreePath);
      yield* fs.makeDirectory(gitDir);
      yield* fs.writeFileString(path.join(worktreePath, ".git"), `gitdir: ${gitDir}\n`);
      const statePath = path.join(gitDir, WORKTREE_SETUP_STATE_FILE);
      const readState = fs
        .readFileString(statePath)
        .pipe(Effect.map((raw) => JSON.parse(raw) as WorktreeSetupState));
      // The settled breadcrumb is written by a detached fiber through real file
      // I/O, so poll on the live clock (the timeout case drives the test clock).
      const awaitStateStatus = (status: string) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 500; attempt++) {
            if ((yield* readState).status === status) break;
            yield* Effect.sleep(10).pipe(TestClock.withLive);
          }
          return yield* readState;
        });

      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      let written = "";
      const closeIdle = vi.fn(() => Effect.void);
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: worktreePath,
          worktreePath,
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn((input: { data: string }) =>
        Effect.sync(() => void (written = input.data)),
      );
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "echo setup",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      return yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        // No `observeCompletion`: the breadcrumb is written for every run.
        yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath,
        });

        expect(yield* readState).toMatchObject({
          status: "pending",
          scriptId: "setup",
          scriptName: "Setup",
        });
        yield* afterStart;
        if (settle === null) return { state: yield* awaitStateStatus("failed"), closeIdle };

        const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
        expect(sentinel).toBeDefined();
        yield* listener!({
          type: "output",
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: `${sentinel}${settle}\r\n`,
        });
        return {
          state: yield* awaitStateStatus(settle === 0 ? "ready" : "failed"),
          closeIdle,
        };
      }).pipe(
        Effect.provide(
          testLayer(project, {
            open,
            write,
            closeIdle,
            subscribe: (next) =>
              Effect.sync(() => {
                listener = next;
                return () => {
                  listener = null;
                };
              }),
          }),
        ),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/bash" }),
      );
    }).pipe(Effect.provide(NodeServices.layer));

  it.effect("writes a pending breadcrumb into the worktree gitdir and flips it to ready", () =>
    Effect.gen(function* () {
      const { state, closeIdle } = yield* runBreadcrumbScenario(0);
      expect(state).toMatchObject({ status: "ready", exitCode: 0 });
      // Upstream's idle-shell close runs even though no caller consumed `completion`.
      expect(closeIdle).toHaveBeenCalledWith({ threadId: "thread-1", terminalId: "setup-setup" });
    }),
  );

  it.effect("flips the breadcrumb to failed when the setup script exits non-zero", () =>
    Effect.gen(function* () {
      const { state, closeIdle } = yield* runBreadcrumbScenario(1);
      expect(state).toMatchObject({
        status: "failed",
        exitCode: 1,
        detail: "Setup script exited with code 1.",
      });
      expect(closeIdle).not.toHaveBeenCalled();
    }),
  );

  // Nothing upstream settles a hung script, and an agent polling `pending`
  // would wait on it forever.
  it.effect("flips the breadcrumb to failed when the setup script hangs for 30 minutes", () =>
    Effect.gen(function* () {
      const { state } = yield* runBreadcrumbScenario(null, TestClock.adjust("30 minutes"));
      expect(state).toMatchObject({
        status: "failed",
        detail: "Setup script timed out after 30 minutes.",
      });
    }),
  );
});
