import { z } from "zod";

/**
 * The one categorical palette every vocabulary-v2 surface shares — `<Badge>`,
 * `<Card>`, `<Stats>`, `<Steps>`, `<Table>` rows/cells, `<Mermaid>` node classes.
 * A tone is a category colour, not a status: meaning rides the text, colour
 * makes it scannable. (`<Callout>` keeps its own five *status* tones.)
 *
 * Colours live in CSS variables (`--plan-tone-<tone>` for text/stroke,
 * `--plan-tone-<tone>-soft` for fills, `index.css`) rather than Tailwind
 * classes, so they also reach a Mermaid SVG `<style>` and a sandboxed iframe.
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
