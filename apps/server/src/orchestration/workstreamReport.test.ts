import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { readWorkstreamReport, writeWorkstreamReport } from "./workstreamReport.ts";

const testLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-workstream-report-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("workstreamReport", () => {
  it.effect("returns an absolute path that round-trips with a read", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const threadId = ThreadId.make("child-1");
      const markdown = "# Done\n\nEverything worked.";

      const reportPath = yield* writeWorkstreamReport(threadId, markdown);

      // The parent orchestrator reads this exact string from its own worktree,
      // so it must be absolute — a bare file name would not resolve there.
      expect(path.isAbsolute(reportPath)).toBe(true);
      expect(yield* readWorkstreamReport(threadId)).toEqual(Option.some(markdown));
    }).pipe(Effect.provide(testLayer)),
  );
});
