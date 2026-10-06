/**
 * mcp__t3-code__workstream_list on V2's real orchestrator: the caller's whole tree joined
 * with the shell — status, report path, waits-on, a synthesised report's
 * marker — and the spawn catalogue; a root before its first Loom write lists
 * itself.
 */
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import {
  loomEvent,
  seedThread,
  writeEvents,
} from "../../../../loom/testkit/loomOrchestratorLayer.ts";
import { callAs, HandlerTestLayer, spawnedId } from "./handlers.testkit.ts";

it.layer(HandlerTestLayer)("workstream list", (it) => {
  it.effect("a root before its first Loom write lists itself and the catalogue", () =>
    Effect.gen(function* () {
      const root = ThreadId.make("list-bare-root");
      yield* seedThread({ threadId: root });
      const result = yield* callAs(root, "workstream_list", {});
      assert.isFalse(result.isError, result.text);
      assert.include(result.text, "Workstream: 1 thread(s).");
      assert.include(result.text, `- ${root} (you) [thread]`);
      assert.include(result.text, '"thorough"');
      assert.include(result.text, "presets: none configured");
    }),
  );

  it.effect("the whole tree from a child: statuses, reports, waits-on, synthesised marker", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const root = ThreadId.make("list-root");
      yield* seedThread({ threadId: root });
      const spawn = (title: string, extra: Record<string, unknown> = {}) =>
        Effect.map(
          callAs(root, "workstream_spawn", { role: "coder", title, purpose: "x", ...extra }),
          (result) => spawnedId(result.text),
        );
      const coder = yield* spawn("Coder");
      const reviewer = yield* spawn("Review", { role: "reviewer", gate: { rework: coder } });
      const quiet = yield* spawn("Quiet");
      yield* callAs(coder, "workstream_submit", { markdown: "done" });
      yield* writeEvents([
        yield* loomEvent("thread.report-set", quiet, {
          reportPath: "/reports/quiet.quiescent-r1.md",
        }),
        yield* loomEvent("thread.outcome-recorded", quiet, {
          outcome: "quiescent",
          decision: "yield",
          round: 0,
          synthesised: true,
        }),
      ]);

      const result = yield* callAs(reviewer, "workstream_list", {});
      assert.isFalse(result.isError, result.text);
      const text = result.text;
      assert.include(text, "Workstream: 4 thread(s).");
      assert.include(text, `- ${root} [thread]`);
      assert.include(text, `  - ${reviewer} (you) [reviewer] "Review" status=ready`);
      assert.include(text, `  - ${coder} [coder] "Coder" status=done`);
      assert.include(text, `report: ${(yield* store.getWorkstream(coder))!.reportPath}`);
      assert.include(text, `waits-on: ${coder}`);
      assert.include(
        text,
        "report: /reports/quiet.quiescent-r1.md (went quiet; report synthesised)",
      );
    }),
  );
});
