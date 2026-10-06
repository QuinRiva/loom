/**
 * `mcp__t3-code__goal_update`: the caller's active goal's title, objective and slug through
 * `LoomStoreV2.goals.upsert`, then published. A slug stays unique among the
 * project's goals (deleted ones included), as V1's decider required.
 *
 * @module mcp/toolkits/workstream/handlers/goalUpdate
 */
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { asToolError, fail, publishGoal, requireActiveGoal } from "./shared.ts";

export const goalUpdate = Effect.fn("LoomToolkit.goalUpdate")(function* (
  input: LoomToolInput<"goal_update">,
  caller: WorkstreamCaller,
) {
  const title = input.title?.trim();
  const slug = input.slug?.trim();
  if (title === "") return yield* fail("title must be a non-empty string.");
  if (slug === "") return yield* fail("slug must be a non-empty string.");
  if (title === undefined && slug === undefined && input.description === undefined)
    return yield* fail("Provide at least one of title, description, or slug.");
  const { goal } = yield* requireActiveGoal(caller.threadId);
  const store = yield* LoomStore.LoomStoreV2;
  if (slug !== undefined && slug !== goal.slug) {
    const taken = yield* asToolError(
      store.goals.listByProject(goal.projectId, { includeDeleted: true }),
    );
    if (taken.some((other) => other.slug === slug))
      return yield* fail(`Slug '${slug}' is already used by another goal in this project.`);
  }
  yield* asToolError(
    store.goals.upsert({
      id: goal.id,
      projectId: goal.projectId,
      slug: slug ?? goal.slug,
      title: title ?? goal.title,
      // May be set to empty, clearing the objective.
      description: input.description ?? goal.description,
    }),
  );
  yield* publishGoal(goal.id);
  return `Updated goal ${goal.id}.`;
});
