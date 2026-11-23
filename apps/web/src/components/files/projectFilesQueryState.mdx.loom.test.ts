import type {
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const server = vi.hoisted(() => ({
  contents: "original",
  reads: [] as Array<{ relativePath: string; maxBytes?: number }>,
}));

vi.mock("~/rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

// The real read query, answered by an in-memory server, so the save's confirmation and the
// preview's read meet (or miss) exactly as they do in the app.
vi.mock("~/state/projects", async () => {
  const { createProjectEnvironmentAtoms } = await import("@t3tools/client-runtime/state/projects");
  const connection = await import("@t3tools/client-runtime/connection");
  const { Atom } = await import("effect/reactivity");
  const SecureRandom = await import("effect/crypto/SecureRandom");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const registry = Layer.effect(
    connection.EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const supervisor = connection.EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new connection.BearerConnectionTarget({
          environmentId: EnvironmentId.make("environment-mdx"),
          label: "Test",
          connectionId: "test",
        }),
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.projectsReadFile]: (input: { relativePath: string; maxBytes?: number }) =>
                Effect.sync(() => {
                  server.reads.push(input);
                  return {
                    relativePath: input.relativePath,
                    contents: server.contents,
                    byteLength: server.contents.length,
                    truncated: false,
                  };
                }),
              [WS_METHODS.filesystemGetMetadata]: (input: { paths: string[] }) =>
                Effect.succeed({ entries: input.paths.map(() => null) }),
            },
          }),
        ),
        state: yield* SubscriptionRef.make({
          ...connection.AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
      } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      return {
        run: (_environmentId, effect) =>
          Effect.provideService(
            effect,
            connection.EnvironmentSupervisor.EnvironmentSupervisor,
            supervisor,
          ),
        followStream: (_environmentId, stream) =>
          Stream.provideService(
            stream,
            connection.EnvironmentSupervisor.EnvironmentSupervisor,
            supervisor,
          ),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"];
    }),
  );
  const runtime = Atom.runtime(
    Layer.mergeAll(
      registry,
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size)),
      ),
    ),
  );
  return {
    projectEnvironment: createProjectEnvironmentAtoms(runtime, {
      projectAtom: () => Atom.make(null),
    }),
  };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-mdx");
const path = "plans/launch/plan.mdx";

describe("saved .mdx edits", () => {
  it.effect("let a later rewrite of the file through to the preview", () =>
    Effect.gen(function* () {
      const preview = getProjectFileQueryAtom(environmentId, "/repo", path);
      yield* Effect.acquireRelease(
        Effect.sync(() => appAtomRegistry.mount(preview)),
        (unmount) => Effect.sync(unmount),
      );
      const read = () =>
        AtomRegistry.getResult(appAtomRegistry, preview, { suspendOnWaiting: true });
      yield* read();
      setProjectFileQueryData(environmentId, "/repo", path, "fixed word");
      server.contents = "fixed word";
      expect(confirmProjectFileQueryData(environmentId, "/repo", path, "fixed word")).toBe(true);
      yield* read();
      expect(getOptimisticProjectFileQueryData(environmentId, "/repo", path)).toBeNull();

      server.contents = "agent rewrite";
      appAtomRegistry.refresh(preview);
      const shown = resolveProjectFileQueryData(environmentId, "/repo", path, yield* read());
      expect(shown?.contents).toBe("agent rewrite");
      expect(server.reads.every((input) => input.maxBytes === 8 * 1024 * 1024)).toBe(true);
    }).pipe(Effect.scoped),
  );
});
