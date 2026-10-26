import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { makePiRpcConnection } from "./rpc.ts";

// A broken pi (#298): passes the `--version` health check, then runs `rpcBody`
// in RPC mode without ever reading stdin.
const brokenPi = (rpcBody: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = (yield* Path.Path).join(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-rpc-broken-" }),
      "pi",
    );
    yield* fs.writeFileString(
      path,
      `#!/bin/sh\ncase "$1" in --version) echo 0.90.0; exit 0;; esac\n${rpcBody}\n`,
    );
    yield* fs.chmod(path, 0o755);
    return path;
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "PiRpc against a pi that dies with a write queued",
  () => {
    // A write larger than the pipe buffer stays queued in libuv. Closing stdout
    // fails the transport and tears down the writer before the process is
    // killed, so the queued write's EPIPE lands after the stdin sink has
    // detached its `error` listener. Unhandled, that crashes the server.
    it.live("fails a session whose queued write hits EPIPE after teardown", () =>
      Effect.gen(function* () {
        const command = yield* brokenPi("exec 1>&-\nsleep 0.5\nexit 1");
        const exit = yield* Effect.gen(function* () {
          const connection = yield* makePiRpcConnection({
            command,
            args: ["--mode", "rpc"],
            cwd: undefined,
            env: process.env,
          });
          yield* connection.send({ type: "prompt", message: "x".repeat(256 * 1024) });
          return yield* connection.request({ type: "get_state" }, 5_000);
        }).pipe(Effect.scoped, Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        // Give the post-teardown EPIPE time to surface as an uncaught error.
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node raises the EPIPE between macrotasks after teardown; no promise marks it
        yield* Effect.sleep("500 millis");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
