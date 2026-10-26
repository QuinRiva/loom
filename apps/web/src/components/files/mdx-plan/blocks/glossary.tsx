import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { z } from "zod";

import {
  Popover,
  PopoverCreateHandle,
  PopoverPopup,
  PopoverTrigger,
} from "~/components/ui/popover";

import type { PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { glossaryKey } from "../glossary";

/**
 * `<Glossary>` / `<Term>`: the document's coined vocabulary as a definition list. Occurrences in
 * prose (`remarkGlossary`) open the definition on hover or tap. ONE detached popover per
 * document (`<GlossaryScope>`), portalled out of `[data-plan-root]` so an open card adds no text
 * to the annotation layer's text-quote search space.
 */

interface GlossaryEntry {
  name: string;
  body: ReactNode;
}

interface GlossaryStore {
  handle: ReturnType<typeof PopoverCreateHandle<string>>;
  definitions: Map<string, GlossaryEntry>;
}

const GlossaryContext = createContext<GlossaryStore | null>(null);

export function GlossaryScope({ children }: { children?: ReactNode }) {
  const [store] = useState<GlossaryStore>(() => ({
    handle: PopoverCreateHandle<string>(),
    definitions: new Map(),
  }));
  return (
    <GlossaryContext.Provider value={store}>
      {children}
      <Popover handle={store.handle}>
        {({ payload }) => {
          const entry = payload === undefined ? undefined : store.definitions.get(payload);
          return (
            <PopoverPopup side="top" width="md" padding="compact">
              <div className="plan-inline-md text-sm">
                <div className="font-semibold">{entry?.name ?? payload}</div>
                {entry && <div className="mt-1 text-muted-foreground">{entry.body}</div>}
              </div>
            </PopoverPopup>
          );
        }}
      </Popover>
    </GlossaryContext.Provider>
  );
}

export function GlossaryTerm({ term, children }: { term?: unknown; children?: ReactNode }) {
  const store = useContext(GlossaryContext);
  if (!store || typeof term !== "string") return <>{children}</>;
  return (
    <PopoverTrigger
      handle={store.handle}
      payload={term}
      openOnHover
      nativeButton={false}
      // A span, not a button: a button's text cannot start a text selection, and
      // the annotation layer anchors comments to selected text.
      render={
        <span className="cursor-help underline decoration-muted-foreground/60 decoration-dotted underline-offset-3 hover:decoration-foreground data-[popup-open]:decoration-foreground" />
      }
    >
      {children}
    </PopoverTrigger>
  );
}

interface TermData {
  name: string;
  /** Inline markdown, rendered as MDX children. */
  definition?: string;
}

const termSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // The prose children, absent from the props the registry validates (as `<Callout>`'s `body`).
  definition: z.string().trim().max(2_000).optional(),
}) as unknown as z.ZodType<TermData>;

function TermRead({ data, children }: PlanBlockReadProps<TermData>) {
  const store = useContext(GlossaryContext);
  // The glossary renders after the prose linking to it, so definitions cannot
  // flow down as context; a card reads this map only when it opens.
  useEffect(() => {
    if (!store) return;
    const key = glossaryKey(data.name);
    store.definitions.set(key, { name: data.name, body: children });
    return () => void store.definitions.delete(key);
  }, [store, data.name, children]);
  return (
    <div>
      <dt className="font-semibold text-foreground">{data.name}</dt>
      <dd className="text-muted-foreground">{children}</dd>
    </div>
  );
}

export const termBlock: PlanBlock<TermData> = {
  schema: termSchema,
  Read: TermRead,
  mdx: {
    tag: "Term",
    childrenField: "definition",
    toAttrs: (data) => ({ name: data.name }),
    fromAttrs: (attrs, children) => ({ name: attrs.string("name") ?? "", definition: children }),
  },
};

const glossarySchema = z.object({}) as unknown as z.ZodType<Record<string, never>>;

function GlossaryRead({ blockId, children }: PlanBlockReadProps<Record<string, never>>) {
  return (
    <section
      data-plan-block-id={blockId}
      data-plan-block-type="glossary"
      className="plan-inline-md my-6 border-t border-border pt-3 text-sm"
    >
      <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Glossary
      </div>
      <dl className="grid gap-2">{children}</dl>
    </section>
  );
}

export const glossaryBlock: PlanBlock<Record<string, never>> = {
  schema: glossarySchema,
  Read: GlossaryRead,
  mdx: { tag: "Glossary", passChildren: true, toAttrs: () => ({}), fromAttrs: () => ({}) },
};
