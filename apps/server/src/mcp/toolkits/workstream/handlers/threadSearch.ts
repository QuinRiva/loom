/**
 * `mcp__t3-code__thread_search`: one `ThreadSearch` call, each root hit joined
 * with its goal's title and the report of the thread that matched (the
 * sub-thread when one did, else the root).
 *
 * @module mcp/toolkits/workstream/handlers/threadSearch
 */
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import * as ThreadSearch from "../../../../orchestration-v2/ThreadSearch.ts";
import type { LoomToolInput } from "../defs.ts";
import { renderThreadSearch } from "../render.ts";
import { asToolError } from "./shared.ts";

export const threadSearch = Effect.fn("LoomToolkit.threadSearch")(function* (
  input: LoomToolInput<"thread_search">,
) {
  const store = yield* LoomStore.LoomStoreV2;
  const query = input.query.trim();
  const { matches } = yield* asToolError(
    (yield* ThreadSearch.ThreadSearch).search({
      query,
      limit: input.limit ?? 10,
      includeArchived: input.includeArchived ?? true,
      ...(input.projectId === undefined ? {} : { projectId: ProjectId.make(input.projectId) }),
    }),
  );
  const rows = yield* asToolError(
    Effect.forEach(
      matches,
      (match) =>
        Effect.gen(function* () {
          const root = yield* store.getWorkstream(match.threadId);
          const matched =
            match.matchedThreadId === null
              ? root
              : yield* store.getWorkstream(match.matchedThreadId);
          const goal = root?.goalId ? yield* store.goals.get(root.goalId) : null;
          return {
            match,
            goalTitle: goal?.title ?? null,
            reportPath: matched?.reportPath ?? null,
          };
        }),
      { concurrency: 8 },
    ),
  );
  return renderThreadSearch(query, rows);
});
