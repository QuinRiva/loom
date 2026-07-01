import * as Schema from "effect/Schema";

/**
 * Shared contracts for first-party MDX plan annotation (the "plannotator" pivot).
 * Schema-only — no runtime logic (that lives in `apps/web`/`packages/shared`).
 *
 * The anchor + comment shapes are adopted from BuilderIO's visual-plan model
 * (`templates/plan/shared/comment-context.ts`) trimmed to the local-files flow:
 * the text-quote subset is populated first, the visual/canvas/wireframe fields
 * are reserved for the deferred Phase 4 tiers. See `docs/mdx-spike-findings.md`
 * §3.1 and `docs/mdx-plannotator-decisions.md` D4.
 */

export const PlanCommentResolutionTarget = Schema.Literals(["agent", "human"]);
export type PlanCommentResolutionTarget = typeof PlanCommentResolutionTarget.Type;

export const PlanCommentMention = Schema.Struct({
  email: Schema.String,
  label: Schema.String,
  role: Schema.optional(Schema.String),
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
 * A rendered-document anchor. The first cut populates the text-quote subset
 * (`textQuote` + `contextBefore`/`contextAfter` + section/block) which the
 * Range-precise resolver re-binds to an exact DOM `Range`; the visual/canvas
 * fields are reserved for later tiers. Whole-block fallback anchoring keys on
 * `blockType` + `targetSelector` / the rendered `data-plan-block-id`.
 */
export const PlanCommentAnchor = Schema.Struct({
  anchorKind: Schema.optional(PlanCommentAnchorKind),
  // --- text-quote (first cut) ---
  textQuote: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  contextBefore: Schema.optional(Schema.String),
  contextAfter: Schema.optional(Schema.String),
  sectionId: Schema.optional(Schema.String),
  sectionTitle: Schema.optional(Schema.String),
  blockType: Schema.optional(Schema.String),
  ambiguous: Schema.optional(Schema.Boolean),
  targetSelector: Schema.optional(Schema.String),
  tagName: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  // --- routing + mentions ---
  resolutionTarget: Schema.optional(PlanCommentResolutionTarget),
  mentions: Schema.optional(Schema.Array(PlanCommentMention)),
  // --- deferred tiers (wireframe node / canvas / visual) ---
  targetKind: Schema.optional(PlanCommentTargetKind),
  targetNodeId: Schema.optional(Schema.String),
  targetNodePath: Schema.optional(Schema.String),
  targetX: Schema.optional(Schema.Number),
  targetY: Schema.optional(Schema.Number),
  canvasX: Schema.optional(Schema.Number),
  canvasY: Schema.optional(Schema.Number),
  canvasWidth: Schema.optional(Schema.Number),
  canvasHeight: Schema.optional(Schema.Number),
});
export type PlanCommentAnchor = typeof PlanCommentAnchor.Type;

export const PlanCommentKind = Schema.Literals(["comment", "draft"]);
export type PlanCommentKind = typeof PlanCommentKind.Type;

export const PlanCommentStatus = Schema.Literals(["open", "resolved"]);
export type PlanCommentStatus = typeof PlanCommentStatus.Type;

export const PlanCommentAuthor = Schema.Literals(["human", "agent"]);
export type PlanCommentAuthor = typeof PlanCommentAuthor.Type;

/**
 * A single plan comment. Trimmed from BuilderIO's `PlanComment` to the
 * local-files flow (DB/org/hosted fields dropped). First cut keeps comments in
 * the composer store rather than a `comments.json` sidecar (decision D5), so
 * this is the shape a future sidecar/import would use, not a wire dependency yet.
 * `planPath` is the `.mdx` path (replaces BuilderIO's `planId`).
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
