// Loom additions to the composer-context contracts: the `mdxAnchor` payload an MDX-plan annotation
// adds to upstream's review-comment record, one spliced optional field.
// HARD CONSTRAINT: never value-import `composerContext.ts` (it imports this file and both evaluate
// schema unions at init, so a value cycle is a TDZ crash).

import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PlanCommentAnchor } from "./plan.ts";

/**
 * The `mdx-anchor` review-comment variant: a rendered-MDX-plan annotation targets a passage or
 * block, not a line range, so `startIndex`/`endIndex`/`diff` carry nothing and these two fields
 * (the anchor and the passage it quotes) carry everything. Their presence is the discriminator.
 */
export const LoomMdxAnchorReviewContext = Schema.Struct({
  anchor: PlanCommentAnchor,
  quotedText: Schema.String.check(Schema.isMaxLength(16_000)),
  /**
   * Set on a comment promoted from a query thread (the transcript's link back);
   * `promotionId` is that promotion's id on the query thread's `documentQuery`.
   */
  queryThreadId: Schema.optionalKey(ThreadId),
  promotionId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type LoomMdxAnchorReviewContext = typeof LoomMdxAnchorReviewContext.Type;
