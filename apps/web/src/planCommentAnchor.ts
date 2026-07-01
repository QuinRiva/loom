import type { PlanCommentAnchor, PlanCommentResolutionTarget } from "@t3tools/contracts";

/**
 * Runtime helpers that render a {@link PlanCommentAnchor} into the agent-facing
 * text the model receives in an injected `<review_comment>` turn. Ported (and
 * trimmed to the text-quote first cut) from BuilderIO's
 * `formatPlanCommentAnchorForAgent` / `planCommentAnchorDetails`
 * (`templates/plan/shared/comment-context.ts`).
 *
 * NOTE (thread coordination): the Phase 1-Fan (server + injection) thread owns
 * the authoritative agent-prompt serialisation of the mdx-anchor review-comment
 * variant. These helpers give a correct, self-contained first cut so the
 * discriminated union is exhaustive and typechecks today; that thread should
 * extend them for the visual/canvas/wireframe tiers as those anchor kinds land.
 */

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function normalizeResolutionTarget(
  value: PlanCommentResolutionTarget | undefined,
): PlanCommentResolutionTarget {
  return value === "human" ? "human" : "agent";
}

/** One-line human-readable location for the anchor ("Section: \"quote\""). */
export function formatPlanCommentAnchorForAgent(anchor: PlanCommentAnchor | null): string {
  if (!anchor) return "";
  const section =
    clean(anchor.sectionTitle) && anchor.sectionTitle !== "Visible plan area"
      ? `${clean(anchor.sectionTitle)}: `
      : "";
  const quote = clean(anchor.textQuote) ?? clean(anchor.snippet);
  if (quote) return `${section}"${quote}"`;
  if (section) return section.replace(/: $/, "");
  if (anchor.x !== undefined && anchor.y !== undefined) {
    return `Pinned at ${Math.round(anchor.x)}% across / ${Math.round(anchor.y)}% down of the plan`;
  }
  return "Pinned to plan";
}

/** Multi-line agent-facing detail block for the anchor (evidence for the model). */
export function planCommentAnchorDetails(anchor: PlanCommentAnchor | null): string[] {
  if (!anchor) return [];
  const lines: string[] = [
    `Expected resolver: ${
      normalizeResolutionTarget(anchor.resolutionTarget) === "human" ? "human reviewer" : "agent"
    }`,
  ];
  const location = formatPlanCommentAnchorForAgent(anchor);
  if (location) lines.push(`Location: ${location}`);
  if (anchor.blockType) lines.push(`Block type: ${anchor.blockType}`);
  if (anchor.targetSelector) lines.push(`Selector: ${anchor.targetSelector}`);
  if (anchor.contextBefore) lines.push(`Text before: "${clean(anchor.contextBefore)}"`);
  if (anchor.contextAfter) lines.push(`Text after: "${clean(anchor.contextAfter)}"`);
  if (anchor.ambiguous) {
    lines.push("Ambiguous: this quote may match more than one place.");
  }
  const mentions = anchor.mentions ?? [];
  if (mentions.length > 0) {
    lines.push(
      `Mentioned: ${mentions.map((mention) => `${mention.label} <${mention.email}>`).join(", ")}`,
    );
  }
  return lines;
}
