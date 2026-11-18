import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A code query thread's run, questions and promotions (`code_query`, JSON `LoomCodeQuery`), folded
// by the projector from `thread.code-query-asked` and `thread.code-query-promoted`. Null on every
// other thread; nothing to backfill.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE loom_thread_workstream ADD COLUMN code_query TEXT`;
});
