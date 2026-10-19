import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { whenV1TableExists } from "../v1Projections.loom.ts";

export default whenV1TableExists(
  "projection_thread_activities",
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind_sequence_created_id
    ON projection_thread_activities(thread_id, kind, sequence, created_at, activity_id)
  `;
  }),
);
