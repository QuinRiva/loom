/**
 * `goal_update`: the active goal's title, objective and slug, upserted then published. A slug stays
 * unique among the project's goals, deleted included. Owner only: a child's edit would become every
 * later child's "parent's objective".
 */
import * as Effect from "effect/Effect";

import { resolveThreadAnchor } from "../../../../loom/goals/goalTaskTree.ts";
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
  const { goal, row } = yield* requireActiveGoal(caller.threadId);
  // The owner is the thread whose rewrite scope is the whole tree: a root with no live anchor.
  if (row.parentThreadId !== null || resolveThreadAnchor(goal.tasks, row.anchorTaskId) !== null)
    return yield* fail(
      "Only the thread that owns this goal (its root orchestrator) or the human can change its title, description or slug.",
    );
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
