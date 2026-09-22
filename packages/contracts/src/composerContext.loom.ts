// Loom (fork) additions to the composer-context contracts: the `thread` record
// behind a `#`-mentioned thread, and the `mdxAnchor` payload an MDX-plan
// annotation adds to upstream's review-comment record. Both ride upstream's
// generic context-reference machinery — same canonical link, same records
// array, same chip segment — so the upstream-owned changes are one spliced
// union member and one spliced optional field.
//
// HARD CONSTRAINT (same as `orchestration.loom.ts`): this file must never
// value-import `composerContext.ts`. The dependency is strictly one-way
// (`composerContext.ts` → this file); both evaluate schema unions at init, so a
// value cycle is a TDZ crash. Upstream's private record base is therefore
// passed IN to `makeLoomThreadContextRecord`.

import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { PlanCommentAnchor } from "./plan.ts";

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

/**
 * What makes a review-comment record the `mdx-anchor` variant rather than the
 * line/diff one: a rendered-MDX-plan annotation (a freeform note, a
 * `<QuestionForm>` answer or a `<ReviewChoice>` verdict) targets a passage or a
 * block, not a line range, so `startIndex`/`endIndex`/`diff` carry nothing and
 * these two fields carry everything — the resolvable anchor and the passage it
 * quotes. Its presence is the discriminator on both the wire and the read side.
 */
export const LoomMdxAnchorReviewContext = Schema.Struct({
  anchor: PlanCommentAnchor,
  quotedText: Schema.String.check(Schema.isMaxLength(16_000)),
});
export type LoomMdxAnchorReviewContext = typeof LoomMdxAnchorReviewContext.Type;
