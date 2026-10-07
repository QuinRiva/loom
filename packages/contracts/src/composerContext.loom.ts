// Loom (fork) additions to the composer-context contracts: the `mdxAnchor`
// payload an MDX-plan annotation adds to upstream's review-comment record. It
// rides upstream's generic context-reference machinery, so the upstream-owned
// change is one spliced optional field. (Loom's `#`-thread record was deleted in
// pull 9: upstream's V2 `ThreadContextRecord` expresses the same thing — DL-88.)
//
// HARD CONSTRAINT (same as `orchestration.loom.ts`): this file must never
// value-import `composerContext.ts`. The dependency is strictly one-way
// (`composerContext.ts` → this file); both evaluate schema unions at init, so a
// value cycle is a TDZ crash.

import * as Schema from "effect/Schema";

import { PlanCommentAnchor } from "./plan.ts";

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
