/**
 * mcp__t3-code__thread_search on V2's real orchestrator and index: a phrase only
 * a child's submitted report holds finds the child's root, credited to the
 * child, with the child's report path.
 */
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import { seedThread } from "../../../../loom/testkit/loomOrchestratorLayer.ts";
import { callAs, HandlerTestLayer, spawnedId } from "./handlers.testkit.ts";

it.layer(HandlerTestLayer)("thread search", (it) => {
  it.effect("a sub-thread's report is found through its root, with the report path", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const root = ThreadId.make("search-root");
      yield* seedThread({ threadId: root });
      const child = spawnedId(
        (yield* callAs(root, "workstream_spawn", {
          role: "researcher",
          title: "Ledger audit",
          purpose: "Audit the ledger.",
        })).text,
      );
      yield* callAs(child, "workstream_submit", {
        markdown:
          "<!-- response -->\nThe quokka reconciliation drifts on leap days.\n<!-- /response -->",
      });
      const reportPath = (yield* store.getWorkstream(child))!.reportPath!;

      const result = yield* callAs(child, "thread_search", { query: "quokka reconciliation" });
      assert.isFalse(result.isError, result.text);
      assert.include(result.text, '1 root thread(s) match "quokka reconciliation"');
      assert.include(result.text, `(${root})`);
      assert.include(result.text, `matched report of sub-thread «Ledger audit» (${child}):`);
      assert.include(result.text, "quokka reconciliation");
      assert.include(result.text, `report: ${reportPath}`);

      const none = yield* callAs(child, "thread_search", { query: "wombat" });
      assert.equal(none.text, 'No thread matches "wombat".');
    }),
  );

  it.effect("includeSubThreads false drops a sub-thread's own text and keeps its report", () =>
    Effect.gen(function* () {
      const root = ThreadId.make("search-roots-only");
      yield* seedThread({ threadId: root });
      const child = spawnedId(
        (yield* callAs(root, "workstream_spawn", {
          role: "researcher",
          title: "Bilby tariff survey",
          purpose: "Survey the tariffs.",
        })).text,
      );
      yield* callAs(child, "workstream_submit", {
        markdown: "<!-- response -->\nThe numbat surcharge is double-counted.\n<!-- /response -->",
      });

      const byTitle = yield* callAs(root, "thread_search", { query: "bilby tariff" });
      assert.include(byTitle.text, `matched title of sub-thread «Bilby tariff survey» (${child}):`);

      const rootsOnly = yield* callAs(root, "thread_search", {
        query: "bilby tariff",
        includeSubThreads: false,
      });
      assert.equal(rootsOnly.text, 'No thread matches "bilby tariff".');

      const report = yield* callAs(root, "thread_search", {
        query: "numbat surcharge",
        includeSubThreads: false,
      });
      assert.include(report.text, `matched report of sub-thread «Bilby tariff survey» (${child}):`);
    }),
  );
});
