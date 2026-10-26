import { z } from "zod";

/**
 * The categorical palette shared by vocabulary-v2 blocks: colour makes a category
 * scannable, meaning rides the text (`<Callout>` keeps its own status tones). Colours
 * are CSS variables (`--plan-tone-<tone>[-soft]`) so they also reach Mermaid SVG
 * `<style>` and sandboxed iframes.
 */
export const toneSchema = z.enum(["neutral", "info", "success", "warning", "risk", "accent"]);
export type Tone = z.infer<typeof toneSchema>;

/** "A badge", written the same way on every block that carries one: a bare
 * label (takes the host's tone) or `{ label, tone? }`. */
export const badgeSpecSchema = z.union([
  z.string().trim().min(1).max(60),
  z.object({ label: z.string().trim().min(1).max(60), tone: toneSchema.optional() }),
]);
export type BadgeSpec = z.infer<typeof badgeSpecSchema>;

/** Resolve a badge spec against the tone a bare string takes on its host. */
export const resolveBadge = (spec: BadgeSpec, hostTone: Tone = "neutral") =>
  typeof spec === "string"
    ? { label: spec, tone: hostTone }
    : { label: spec.label, tone: spec.tone ?? hostTone };

/** Class for the shared pill look (`.plan-badge`, `index.css`). */
export const badgeClass = (tone: Tone = "neutral") => `plan-badge plan-badge--${tone}`;

/** The tone's text/stroke colour as a CSS value, for an inline `style`. */
export const toneColor = (tone: Tone) => `var(--plan-tone-${tone})`;
