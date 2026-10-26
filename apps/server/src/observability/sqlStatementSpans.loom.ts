import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

/**
 * Per-statement `sqlite` spans were over half the trace file's bytes on the cockpit (~40 a second,
 * each carrying its query text), cutting the rotated window to ~25 minutes. They are dropped unless
 * `T3CODE_TRACE_SQL_STATEMENTS=true`; `sql.transaction` and every other span still export.
 */
export const withoutSqlStatementSpans = Effect.fn("withoutSqlStatementSpans")(function* (
  tracer: Tracer.Tracer,
) {
  const enabled = yield* Config.Boolean("T3CODE_TRACE_SQL_STATEMENTS").pipe(
    Config.withDefault(false),
  );
  return enabled
    ? tracer
    : Tracer.make({
        span: (options) =>
          options.name === "sqlite"
            ? new Tracer.NativeSpan({ ...options, sampled: false })
            : tracer.span(options),
        ...(tracer.context ? { context: tracer.context } : {}),
      });
});
