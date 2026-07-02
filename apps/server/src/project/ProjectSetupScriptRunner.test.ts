import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import { type OrchestrationProject, ProjectId, type TerminalWriteInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

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
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getGoalShellById: () => Effect.die("unused in this test"),
    getPendingTurnStartThreadIds: () => Effect.die("unused in this test"),
    getActivityFreshnessByThreadId: () => Effect.die("unused in this test"),
    getRecentToolActivityByThreadId: () => Effect.die("unused in this test"),
    getThreadProgressSignal: () => Effect.die("unused in this test"),
    getInFlightToolByThreadId: () => Effect.die("unused in this test"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
  });

const makeTerminalManagerLayer = (
  overrides: Pick<TerminalManager.TerminalManager["Service"], "open" | "write"> &
    Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe">>,
) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    ...overrides,
    attachStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    subscribe: overrides.subscribe ?? (() => Effect.succeed(() => undefined)),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  });

const testLayer = (
  project: OrchestrationProject,
  terminal: Pick<TerminalManager.TerminalManager["Service"], "open" | "write"> &
    Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe">>,
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(terminal)),
    Layer.provideMerge(NodeServices.layer),
  );

describe("ProjectSetupScriptRunner", () => {
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

        expect(result).toMatchObject({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
        });
        expect(open).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          env: {
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          },
        });
        expect(write).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: expect.stringMatching(
            /^bun install\rprintf '\\n__T3CODE_SETUP_DONE_[0-9a-f]+__:%s\\n' "\$\?"\r$/,
          ),
        });
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    },
  );

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
            /^pnpm install --frozen-lockfile\rprintf '\\n__T3CODE_SETUP_DONE_[0-9a-f]+__:%s\\n' "\$\?"\r$/,
          ),
        });
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves completion only after the terminal emits the setup marker", () => {
    let listener: Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0] | null =
      null;
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
    let writtenData = "";
    const write = vi.fn((input: TerminalWriteInput) =>
      Effect.sync(() => {
        writtenData = input.data;
      }),
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
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      });
      const marker = writtenData.match(/(__T3CODE_SETUP_DONE_[0-9a-f]+__:)/)?.[1];

      expect(marker).toBeDefined();
      expect(listener).not.toBeNull();
      if (result.status !== "started" || !marker) return yield* Effect.die("setup did not start");
      yield* listener!({
        type: "output",
        threadId: "thread-1",
        terminalId: "setup-setup",
        data: `${marker}0`,
      });

      expect(yield* result.completion).toEqual({ exitCode: 0 });
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open,
          write,
          subscribe: (next) =>
            Effect.sync(() => {
              listener = next;
              return () => undefined;
            }),
        }),
      ),
    );
  });

  const runBreadcrumbScenario = (exitCode: number) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "t3-setup-state-" });
      const worktreePath = path.join(dir, "worktree");
      const gitDir = path.join(dir, "gitdir");
      yield* fs.makeDirectory(worktreePath);
      yield* fs.makeDirectory(gitDir);
      yield* fs.writeFileString(path.join(worktreePath, ".git"), `gitdir: ${gitDir}\n`);
      const statePath = path.join(gitDir, ProjectSetupScriptRunner.WORKTREE_SETUP_STATE_FILE);
      const readState = fs
        .readFileString(statePath)
        .pipe(Effect.map((raw) => JSON.parse(raw) as ProjectSetupScriptRunner.WorktreeSetupState));
      const awaitStateStatus = (status: string) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 500; attempt++) {
            if ((yield* readState).status === status) break;
            yield* Effect.sleep(10);
          }
          return yield* readState;
        });

      let listener: Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0] | null =
        null;
      let writtenData = "";
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
      const write = vi.fn((input: TerminalWriteInput) =>
        Effect.sync(() => {
          writtenData = input.data;
        }),
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

        const marker = writtenData.match(/(__T3CODE_SETUP_DONE_[0-9a-f]+__:)/)?.[1];
        expect(marker).toBeDefined();
        yield* listener!({
          type: "output",
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: `${marker}${exitCode}`,
        });

        return yield* awaitStateStatus(exitCode === 0 ? "ready" : "failed");
      }).pipe(
        Effect.provide(
          testLayer(project, {
            open,
            write,
            subscribe: (next) =>
              Effect.sync(() => {
                listener = next;
                return () => undefined;
              }),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer));

  it.effect("writes a pending breadcrumb into the worktree gitdir and flips it to ready", () =>
    Effect.gen(function* () {
      const state = yield* runBreadcrumbScenario(0);
      expect(state).toMatchObject({ status: "ready", exitCode: 0 });
    }).pipe(TestClock.withLive),
  );

  it.effect("flips the breadcrumb to failed when the setup script exits non-zero", () =>
    Effect.gen(function* () {
      const state = yield* runBreadcrumbScenario(1);
      expect(state).toMatchObject({ status: "failed" });
      expect(state.detail).toContain("exited with code 1");
    }).pipe(TestClock.withLive),
  );

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
});
