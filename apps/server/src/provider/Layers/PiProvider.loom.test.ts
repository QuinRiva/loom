// loom: Area H — a new Pi thread with no explicit pick lands on Loom's PI_DEFAULT_MODEL, not on
// the "Pi default" sentinel that defers to pi's own settings.json (driver plan §5a, DR-9).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PI_DEFAULT_MODEL } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { checkPiProviderStatus } from "./PiProvider.ts";

const encoder = new TextEncoder();
const [provider, id] = PI_DEFAULT_MODEL.split("/") as [string, string];
const RPC_DATA: Record<string, unknown> = {
  get_state: { thinkingLevel: "high" },
  get_available_models: {
    models: [
      { provider: "cliproxy", id: "claude-fable-5-1", name: "Fable" },
      { provider, id, name: "Loom default" },
    ],
  },
  get_commands: { commands: [] },
};

/** `pi --version` prints a version; `pi --mode rpc` answers the three discovery requests. */
const fakePiSpawner = ChildProcessSpawner.make((command) =>
  Effect.gen(function* () {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    if (args.includes("--version")) {
      yield* Queue.offer(stdout, encoder.encode("pi 1.0.2\n"));
      yield* Queue.end(stdout);
    }
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(900_000_002),
      exitCode: args.includes("--version")
        ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
        : Effect.never,
      isRunning: Effect.succeed(!args.includes("--version")),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Effect.forEach(
          new TextDecoder().decode(chunk).split("\n").filter(Boolean),
          (line) => {
            const request = JSON.parse(line) as { readonly id: string; readonly type: string };
            const response = {
              type: "response",
              id: request.id,
              command: request.type,
              success: true,
              data: RPC_DATA[request.type],
            };
            return Queue.offer(stdout, encoder.encode(`${JSON.stringify(response)}\n`));
          },
          { discard: true },
        ),
      ),
      stdout: Stream.fromQueue(stdout),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  }),
);

it.effect(
  "flags the discovered PI_DEFAULT_MODEL as the default and leaves the sentinel unflagged",
  () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus({
        enabled: true,
        binaryPath: "pi",
        launchArgs: "",
        customModels: [],
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakePiSpawner));
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(
        snapshot.models.map((model) => [model.slug, model.isDefault === true]),
        [
          ["default", false],
          ["cliproxy/claude-fable-5-1", false],
          [PI_DEFAULT_MODEL, true],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
