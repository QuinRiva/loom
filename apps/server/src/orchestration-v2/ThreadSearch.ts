import type {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

// loom: upstream's LIKE scan over active threads' messages is replaced by loom's
// hybrid index (FTS5 + embeddings) over every thread's content, credited to roots.
import { makeThreadSearch } from "./ThreadSearch.loom.ts";

export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threadSearch = yield* makeThreadSearch; // loom
  return ThreadSearch.of({
    search: (input) =>
      threadSearch
        .searchThreads(input)
        .pipe(Effect.mapError((cause) => new ThreadSearchError({ operation: "query", cause }))),
  });
});

export const layer = Layer.effect(ThreadSearch, make);
