/**
 * loom: the worktree-readiness breadcrumb (DL-73) and the pnpm install rewrite,
 * re-hung in pull 9 (DL-97) on upstream's `ProjectService` harness. The V1-harness
 * originals are in `quarantine/apps/server/src/project/ProjectSetupScriptRunner.test.ts`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import { ProjectId, type TerminalEvent } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import {
  WORKTREE_SETUP_STATE_FILE,
  type WorktreeSetupState,
} from "./ProjectSetupScriptRunner.loom.ts";

const makeProject = (command: string, workspaceRoot: string) => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  scripts: [
    { id: "setup", name: "Setup", command, icon: "configure" as const, runOnWorktreeCreate: true },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

type TerminalService = TerminalManager.TerminalManager["Service"];

const terminalSession = (worktreePath: string) => ({
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
});

const runWith = <A, E, R>(
  project: ReturnType<typeof makeProject>,
  terminal: Pick<TerminalService, "open" | "write"> &
    Partial<Pick<TerminalService, "subscribe" | "closeIdle">>,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(
      ProjectSetupScriptRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeed(Option.some(project)),
              getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
            }),
            Layer.mock(TerminalManager.TerminalManager)({
              subscribe: () => Effect.succeed(() => undefined),
              closeIdle: () => Effect.void,
              ...terminal,
            }),
            ServerSettings.layerTest(),
            NodeServices.layer,
          ),
        ),
      ),
    ),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/bash" }),
  );

describe("ProjectSetupScriptRunner (loom)", () => {
  it.effect("uses pnpm frozen install when a pnpm worktree would otherwise run bun install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreePath = yield* fs.makeTempDirectory({ prefix: "t3-setup-pnpm-" });
      yield* fs.writeFileString(path.join(worktreePath, "pnpm-lock.yaml"), "");
      const write = vi.fn((_input: Parameters<TerminalService["write"]>[0]) => Effect.void);

      yield* runWith(
        makeProject("bun install", worktreePath),
        { open: () => Effect.succeed(terminalSession(worktreePath)), write },
        Effect.gen(function* () {
          const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
          yield* runner.runForThread({ threadId: "thread-1", projectCwd: worktreePath, worktreePath });
        }),
      );

      expect(write).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-setup",
        data: expect.stringMatching(
          /^\( pnpm install --frozen-lockfile\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
        ) as unknown as string,
      });
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
      const readState = fs
        .readFileString(path.join(gitDir, WORKTREE_SETUP_STATE_FILE))
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
      const closeIdle = vi.fn((_input: Parameters<TerminalService["closeIdle"]>[0]) => Effect.void);

      return yield* runWith(
        makeProject("echo setup", "/repo/project"),
        {
          open: () => Effect.succeed(terminalSession(worktreePath)),
          write: (input) => Effect.sync(() => void (written = input.data)),
          closeIdle,
          subscribe: (next) =>
            Effect.sync(() => {
              listener = next;
              return () => {
                listener = null;
              };
            }),
        },
        Effect.gen(function* () {
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
        }),
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
