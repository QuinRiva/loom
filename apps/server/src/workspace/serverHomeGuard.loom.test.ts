// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as NetService from "@t3tools/shared/Net";
import { resolveServerConfig } from "../cli/config.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { classifyRuntimeHolder, selectServerBaseDir } from "./serverHomeGuard.loom.ts";

const encodeRuntimeState = Schema.encodeEffect(Schema.fromJsonString(PersistedServerRuntimeState));

const COCKPIT = "/home/carl/.t3/cockpit";
const WORKTREE = `${COCKPIT}/worktrees/t3code-ea251a06/ws-guard`;

describe("selectServerBaseDir", () => {
  it("lets --base-dir win over everything", () => {
    expect(
      selectServerBaseDir({
        flagBaseDir: "/tmp/explicit",
        envHome: COCKPIT,
        defaultHome: "/home/carl/.t3",
        worktreePath: WORKTREE,
      }),
    ).toMatchObject({ baseDir: "/tmp/explicit", rule: "flag" });
  });

  it("gives a worktree this install provisioned its own .t3, outranking T3CODE_HOME", () => {
    expect(
      selectServerBaseDir({
        envHome: COCKPIT,
        defaultHome: "/home/carl/.t3",
        worktreePath: WORKTREE,
      }),
    ).toEqual({ baseDir: `${WORKTREE}/.t3`, rule: "worktree", displacedHome: COCKPIT });
  });

  it("leaves an unrelated worktree on T3CODE_HOME (the deployed release tree)", () => {
    // `~/loom-releases/current` is a linked worktree of the release repo, and
    // deployctl's smoke boot runs from one too. Neither was provisioned by the
    // home they run against, so both keep their configured home.
    expect(
      selectServerBaseDir({
        envHome: COCKPIT,
        defaultHome: "/home/carl/.t3",
        worktreePath: "/home/carl/loom-releases/releases/20260922-051919-576d1e8",
      }),
    ).toEqual({ baseDir: COCKPIT, rule: "env" });
  });

  it("falls through T3CODE_HOME, the bootstrap envelope, then ~/.t3", () => {
    expect(selectServerBaseDir({ envHome: COCKPIT, defaultHome: "/home/carl/.t3" })).toEqual({
      baseDir: COCKPIT,
      rule: "env",
    });
    expect(
      selectServerBaseDir({ bootstrapHome: "/tmp/desktop", defaultHome: "/home/carl/.t3" }),
    ).toEqual({ baseDir: "/tmp/desktop", rule: "bootstrap" });
    expect(selectServerBaseDir({ defaultHome: "/home/carl/.t3" })).toEqual({
      baseDir: "/home/carl/.t3",
      rule: "default",
    });
  });

  it("applies the worktree rule against the default home too", () => {
    expect(
      selectServerBaseDir({
        defaultHome: "/home/carl/.t3",
        worktreePath: "/home/carl/.t3/worktrees/feature",
      }),
    ).toMatchObject({ baseDir: "/home/carl/.t3/worktrees/feature/.t3", rule: "worktree" });
  });
});

describe("classifyRuntimeHolder", () => {
  const holder = { holderPid: 4242, selfPid: 99, alive: true, cmdline: undefined };

  it("treats a dead pid as free so a stale lockfile is overwritten", () => {
    expect(classifyRuntimeHolder({ ...holder, alive: false, cmdline: "node bin.mjs" })).toBe(
      "free",
    );
  });

  it("refuses a live server pid, from source or from the bundle", () => {
    expect(
      classifyRuntimeHolder({
        ...holder,
        cmdline: "node apps/server/src/bin.ts serve --port 47311",
      }),
    ).toBe("held");
    expect(
      classifyRuntimeHolder({
        ...holder,
        cmdline: "/home/carl/.n/bin/node apps/server/dist/bin.mjs",
      }),
    ).toBe("held");
  });

  it("ignores a live pid that is plainly not a server (recycled pid)", () => {
    expect(classifyRuntimeHolder({ ...holder, cmdline: "sleep 600" })).toBe("free");
  });

  it("treats an unreadable command line as held, and our own pid as free", () => {
    expect(classifyRuntimeHolder(holder)).toBe("held");
    expect(classifyRuntimeHolder({ ...holder, holderPid: 99 })).toBe("free");
  });
});

it.layer(NodeServices.layer)("a refused boot touches nothing in the home", (it) => {
  it.effect("fails before ensureServerDirectories sweeps the live home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-home-busy-" });

      // A live process whose command line the guard recognises as a server.
      // `bin.mjs` is what the entrypoint is called in a built release.
      const fakeServer = path.join(baseDir, "bin.mjs");
      yield* fs.writeFileString(fakeServer, "setTimeout(() => {}, 60_000);\n");
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeChildProcess.spawn(process.execPath, [fakeServer], { stdio: "ignore" }),
        ),
        (spawned) => Effect.sync(() => spawned.kill()),
      );

      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        yield* encodeRuntimeState({
          version: 1,
          pid: child.pid ?? process.pid,
          port: 8788,
          origin: "http://127.0.0.1:8788",
          startedAt: "2026-09-22T22:42:01.449Z",
        }),
      );

      const outcome = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.some(8789),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
        { refuseWhenHomeIsLive: true },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
        Effect.flip,
      );

      expect(outcome._tag).toBe("ServerHomeBusyError");
      // The sweep lives in ensureServerDirectories, which creates these.
      expect(yield* fs.exists(path.join(stateDir, "logs"))).toBe(false);
      expect(yield* fs.exists(path.join(stateDir, "attachments"))).toBe(false);
    }),
  );
});
