import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { readWorkstreamBriefAt, writeWorkstreamBrief } from "./workstreamBrief.ts";

const testLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-workstream-brief-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("workstreamBrief", () => {
  it.effect("returns an absolute path that round-trips with a read", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const threadId = ThreadId.make("child-1");
      const markdown = "# Kickoff\n\nBuild the thing.";

      const briefPath = yield* writeWorkstreamBrief(threadId, markdown);

      expect(path.isAbsolute(briefPath)).toBe(true);
      expect(yield* readWorkstreamBriefAt(briefPath)).toEqual(Option.some(markdown));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("atomically overwrites a prior brief at the same path", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("child-2");
      const first = yield* writeWorkstreamBrief(threadId, "first");
      const second = yield* writeWorkstreamBrief(threadId, "second");

      // Same stable path; last write wins, no leftover temp files observed.
      expect(second).toBe(first);
      expect(yield* readWorkstreamBriefAt(second)).toEqual(Option.some("second"));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reads none for a missing brief file", () =>
    Effect.gen(function* () {
      expect(yield* readWorkstreamBriefAt("/no/such/brief.md")).toEqual(Option.none());
    }).pipe(Effect.provide(testLayer)),
  );
});
