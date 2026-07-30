// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { makeWorkspaceLease } from "./WorkspaceLease.ts";

const PATH = "/wt/child";

describe("WorkspaceLease", () => {
  it.effect("an outstanding hold blocks exclusive access; releasing it restores access", () =>
    Effect.gen(function* () {
      const lease = yield* makeWorkspaceLease;
      const held = yield* lease.hold(PATH, "session-a");

      const blocked = yield* lease.withExclusive(PATH, Effect.succeed("removed"));
      expect(Option.isNone(blocked)).toBe(true);

      yield* held.release;
      expect(yield* lease.withExclusive(PATH, Effect.succeed("removed"))).toEqual(
        Option.some("removed"),
      );
    }),
  );

  it.effect("many concurrent holders coexist; exclusivity waits for the LAST release", () =>
    Effect.gen(function* () {
      // An occupant lease, not a mutex: a coder process, a resumed Discuss
      // session, and provisioning can all legitimately be in one workspace.
      const lease = yield* makeWorkspaceLease;
      const holds = yield* Effect.forEach(["a", "b", "c"], (id) => lease.hold(PATH, id));

      yield* holds[0]!.release;
      yield* holds[1]!.release;
      expect(Option.isNone(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);

      yield* holds[2]!.release;
      expect(Option.isSome(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);
    }),
  );

  it.effect("releasing a hold twice does not over-release the path", () =>
    Effect.gen(function* () {
      // Both the exit event and an explicit stop release the same session's
      // hold; a double release that credited a spare permit would let a removal
      // proceed while another process was still holding the workspace.
      const lease = yield* makeWorkspaceLease;
      const first = yield* lease.hold(PATH, "session-a");
      const second = yield* lease.hold(PATH, "session-b");

      yield* first.release;
      yield* first.release;
      expect(Option.isNone(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);

      yield* second.release;
      expect(Option.isSome(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);
    }),
  );

  it.effect("a hold cannot be granted while a removal is in flight", () =>
    Effect.gen(function* () {
      // The other half of atomicity: it is not enough that removal sees no
      // holder — a process must not be able to start mid-removal either, or the
      // launch would proceed into a directory being deleted.
      const lease = yield* makeWorkspaceLease;
      const gate = yield* Deferred.make<void>();
      const granted = yield* Ref.make(false);

      const removal = yield* Effect.forkChild(
        lease.withExclusive(PATH, Deferred.await(gate).pipe(Effect.as("removed"))),
        { startImmediately: true },
      );

      const holder = yield* Effect.forkChild(
        lease.hold(PATH, "late-session").pipe(Effect.andThen(Ref.set(granted, true))),
        { startImmediately: true },
      );
      yield* Effect.yieldNow;
      expect(yield* Ref.get(granted)).toBe(false);

      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(removal)).toEqual(Option.some("removed"));
      yield* Fiber.join(holder);
      expect(yield* Ref.get(granted)).toBe(true);
    }),
  );

  it.effect("holds on distinct paths are independent", () =>
    Effect.gen(function* () {
      const lease = yield* makeWorkspaceLease;
      yield* lease.hold(PATH, "session-a");
      expect(Option.isSome(yield* lease.withExclusive("/wt/other", Effect.void))).toBe(true);
    }),
  );

  it.effect("paths are matched after resolution, not by raw string", () =>
    Effect.gen(function* () {
      const lease = yield* makeWorkspaceLease;
      yield* lease.hold(`${PATH}/../child`, "session-a");
      expect(Option.isNone(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);
      expect((yield* lease.occupiedPaths).has(NodePath.resolve(PATH))).toBe(true);
    }),
  );

  it.effect("releaseHolder drops every hold a dead process owned, across paths", () =>
    Effect.gen(function* () {
      // The death path: a process that exited holds nothing anywhere, whether or
      // not it exited cleanly and whether or not its handles are reachable.
      const lease = yield* makeWorkspaceLease;
      yield* lease.hold(PATH, "dead-process");
      yield* lease.hold("/wt/other", "dead-process");
      yield* lease.hold(PATH, "live-process");

      yield* lease.releaseHolder("dead-process");
      expect(Option.isSome(yield* lease.withExclusive("/wt/other", Effect.void))).toBe(true);
      // The surviving process's own hold is untouched.
      expect(Option.isNone(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);
    }),
  );

  it.effect("a failing removal still releases exclusivity", () =>
    Effect.gen(function* () {
      const lease = yield* makeWorkspaceLease;
      yield* Effect.flip(lease.withExclusive(PATH, Effect.fail("git failed")));
      // A git error must not wedge the path: the next pass retries it.
      expect(Option.isSome(yield* lease.hold(PATH, "session-a").pipe(Effect.asSome))).toBe(true);
    }),
  );

  it.effect("interrupting a queued hold does not corrupt the path's permit accounting", () =>
    Effect.gen(function* () {
      // Round-1 review finding 1. A hold that queues behind an in-flight removal
      // and is then interrupted (user cancel, superseded launch, shutdown) must
      // leave the pool exactly as it found it. Getting this wrong in the
      // permissive direction is the production incident re-armed: one spare
      // permit and `withExclusive` succeeds while a live process holds the tree.
      const lease = yield* makeWorkspaceLease;
      const gate = yield* Deferred.make<void>();

      const removal = yield* Effect.forkChild(lease.withExclusive(PATH, Deferred.await(gate)), {
        startImmediately: true,
      });
      // Queue a hold behind the removal, then interrupt it while it waits.
      const queued = yield* Effect.forkChild(lease.hold(PATH, "cancelled-launch"), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(queued);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(removal);

      // A real launch now holds the workspace, so removal must be refused.
      const live = yield* lease.hold(PATH, "live-launch");
      expect(Option.isNone(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);

      // And the path is not wedged in the other direction either: once the live
      // hold releases, exclusivity is obtainable again.
      yield* live.release;
      expect(Option.isSome(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);
    }),
  );

  it.effect("an interrupted queued hold never becomes an occupant", () =>
    Effect.gen(function* () {
      // The complementary direction: the interrupted acquisition must not leave a
      // phantom hold behind, which would make the workspace immortal.
      const lease = yield* makeWorkspaceLease;
      const gate = yield* Deferred.make<void>();

      const removal = yield* Effect.forkChild(lease.withExclusive(PATH, Deferred.await(gate)), {
        startImmediately: true,
      });
      const queued = yield* Effect.forkChild(lease.hold(PATH, "cancelled-launch"), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(queued);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(removal);

      expect((yield* lease.occupiedPaths).has(NodePath.resolve(PATH))).toBe(false);
      expect(Option.isSome(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);
    }),
  );

  it.effect("releasing one holder's hold leaves another holder's hold on the same path", () =>
    Effect.gen(function* () {
      // Round-1 review finding 2, at the primitive level: holder identity must be
      // fine-grained enough that releasing a dead occupant cannot drop a live
      // one's hold on the same workspace.
      const lease = yield* makeWorkspaceLease;
      yield* lease.hold(PATH, "launch-1");
      yield* lease.hold(PATH, "launch-2");

      yield* lease.releaseHolder("launch-1");
      expect(Option.isNone(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);

      yield* lease.releaseHolder("launch-2");
      expect(Option.isSome(yield* lease.withExclusive(PATH, Effect.void))).toBe(true);
    }),
  );
});
