import * as Effect from "effect/Effect";

/**
 * Created the V1 thread-search index (FTS5 over the V1 projections). Upstream's
 * 063 dropped its source tables and nothing read it after pull 9 (DL-82), so a
 * fresh database skips it and 1060 drops it where it ran.
 */
export default Effect.void;
