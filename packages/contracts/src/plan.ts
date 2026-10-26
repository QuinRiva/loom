import * as Schema from "effect/Schema";

/**
 * Schema-only contracts for first-party MDX plan annotation. The anchor and comment shapes adopt
 * BuilderIO's visual-plan model (`templates/plan/shared/comment-context.ts`), trimmed to the
 * local-files flow: the text-quote subset is populated, the visual/canvas fields are reserved.
 */

export const PlanCommentResolutionTarget = Schema.Literals(["agent", "human"]);
export type PlanCommentResolutionTarget = typeof PlanCommentResolutionTarget.Type;

export const PlanCommentMention = Schema.Struct({
  email: Schema.String,
  label: Schema.String,
  role: Schema.optionalKey(Schema.String),
});
export type PlanCommentMention = typeof PlanCommentMention.Type;

export const PlanCommentAnchorKind = Schema.Literals([
  "text",
  "visual",
  "point",
  "wireframe",
  "canvas",
]);
export type PlanCommentAnchorKind = typeof PlanCommentAnchorKind.Type;

/**
 * What kind of thing an anchor points at. `text` is the prose text-quote path
 * (first cut); the rest are reserved for the deferred visual/canvas tiers so the
 * anchor model is extensible without a rewrite (tagged-union, decision D4).
 */
export const PlanCommentTargetKind = Schema.Literals([
  "text",
  "image",
  "diagram",
  "table",
  "code",
  "block",
  "wireframe",
  "canvas",
  "prototype",
  "control",
  "unknown",
]);
export type PlanCommentTargetKind = typeof PlanCommentTargetKind.Type;

/**
 * A rendered-document anchor. The text-quote subset (`textQuote`, context, section/block) is
 * re-bound to an exact DOM `Range`; whole-block fallback keys on `blockType` + `targetSelector` /
 * `data-plan-block-id`. Keys are exact-optional: the wire's JSON encoding rejects an explicit
 * `undefined`, so producers must omit an absent field.
 */
export const PlanCommentAnchor = Schema.Struct({
  anchorKind: Schema.optionalKey(PlanCommentAnchorKind),
  // text-quote (first cut)
  textQuote: Schema.optionalKey(Schema.String),
  snippet: Schema.optionalKey(Schema.String),
  contextBefore: Schema.optionalKey(Schema.String),
  contextAfter: Schema.optionalKey(Schema.String),
  sectionId: Schema.optionalKey(Schema.String),
  sectionTitle: Schema.optionalKey(Schema.String),
  blockType: Schema.optionalKey(Schema.String),
  ambiguous: Schema.optionalKey(Schema.Boolean),
  targetSelector: Schema.optionalKey(Schema.String),
  tagName: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.Number),
  y: Schema.optionalKey(Schema.Number),
  // routing + mentions
  resolutionTarget: Schema.optionalKey(PlanCommentResolutionTarget),
  mentions: Schema.optionalKey(Schema.Array(PlanCommentMention)),
  // deferred tiers (wireframe node / canvas / visual)
  targetKind: Schema.optionalKey(PlanCommentTargetKind),
  targetNodeId: Schema.optionalKey(Schema.String),
  targetNodePath: Schema.optionalKey(Schema.String),
  targetX: Schema.optionalKey(Schema.Number),
  targetY: Schema.optionalKey(Schema.Number),
  canvasX: Schema.optionalKey(Schema.Number),
  canvasY: Schema.optionalKey(Schema.Number),
  canvasWidth: Schema.optionalKey(Schema.Number),
  canvasHeight: Schema.optionalKey(Schema.Number),
});
export type PlanCommentAnchor = typeof PlanCommentAnchor.Type;

export const PlanCommentKind = Schema.Literals(["comment", "draft"]);
export type PlanCommentKind = typeof PlanCommentKind.Type;

export const PlanCommentStatus = Schema.Literals(["open", "resolved"]);
export type PlanCommentStatus = typeof PlanCommentStatus.Type;

export const PlanCommentAuthor = Schema.Literals(["human", "agent"]);
export type PlanCommentAuthor = typeof PlanCommentAuthor.Type;

/**
 * A single plan comment, BuilderIO's `PlanComment` trimmed to the local-files flow (`planPath` is
 * the `.mdx` path). Comments live in the composer store for now, so this is the shape a future
 * sidecar or import would use, not a wire dependency yet.
 */
export const PlanComment = Schema.Struct({
  id: Schema.String,
  planPath: Schema.String,
  parentCommentId: Schema.optional(Schema.NullOr(Schema.String)),
  kind: PlanCommentKind,
  status: PlanCommentStatus,
  anchor: Schema.optional(Schema.NullOr(PlanCommentAnchor)),
  message: Schema.String,
  createdBy: PlanCommentAuthor,
  resolutionTarget: Schema.optional(PlanCommentResolutionTarget),
  mentions: Schema.optional(Schema.Array(PlanCommentMention)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PlanComment = typeof PlanComment.Type;
