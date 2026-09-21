// Loom (fork) addition to the composer-context contracts: the `thread` record
// behind a `#`-mentioned thread. It rides upstream's generic context-reference
// machinery — same canonical link, same records array, same chip segment — so
// the only upstream-owned change is one spliced union member.
//
// HARD CONSTRAINT (same as `orchestration.loom.ts`): this file must never
// value-import `composerContext.ts`. The dependency is strictly one-way
// (`composerContext.ts` → this file); both evaluate schema unions at init, so a
// value cycle is a TDZ crash. Upstream's private record base is therefore
// passed IN to `makeLoomThreadContextRecord`.

import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/**
 * A thread the user mentioned with `#`. `threadId` is the durable identity the
 * agent acts on; `label` (from the shared record base) is the title captured at
 * mention time and is display-only — never identity.
 */
export const makeLoomThreadContextRecord = <const Base extends Schema.Struct.Fields>(base: Base) =>
  Schema.Struct({
    ...base,
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
  });
