import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A query thread's document, questions and promotions (`document_query`, JSON
// `LoomDocumentQuery`), folded by the projector from `thread.document-query-asked`
// and `thread.document-query-promoted`. Null on every other thread; nothing to backfill.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE loom_thread_workstream ADD COLUMN document_query TEXT`;
});
