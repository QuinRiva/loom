import type { ReactNode } from "react";
import { z } from "zod";

import type { PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * `<Sidenote>`: a source or aside written inline straight after the sentence it supports.
 * `.plan-sidenote` in index.css floats it into a margin its own paragraph reserves, or
 * drops it to a line under the claim in a narrow container. Prose, like `<Badge>`; the
 * text-boundary marker keeps its words out of a quote of the sentence before it.
 */

const sidenoteSchema = z.object({}) as unknown as z.ZodType<Record<string, never>>;

function SidenoteRead({ children }: PlanBlockReadProps<Record<string, never>>) {
  return (
    <small className="plan-sidenote" data-plan-text-boundary>
      {children as ReactNode}
    </small>
  );
}

export const sidenoteBlock: PlanBlock<Record<string, never>> = {
  schema: sidenoteSchema,
  Read: SidenoteRead,
  mdx: {
    tag: "Sidenote",
    passChildren: true,
    inline: true,
    toAttrs: () => ({}),
    fromAttrs: () => ({}),
  },
};
