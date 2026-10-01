import {
  compileReferenceLinks,
  type ReferenceLinker,
  type ReferenceLinkRule,
  splitReferenceLinks,
} from "@t3tools/client-runtime/reference-links";
import { createContext, type ReactNode, use } from "react";

/**
 * Web rendering of project reference links (`.t3code/links.json`, see
 * `@t3tools/client-runtime/reference-links`). ChatView provides the active
 * project's rules; chat markdown and MDX documents linkify through
 * `remarkReferenceLinks`, plain-text surfaces through {@link LinkifiedText}.
 */

const ReferenceLinksContext = createContext<ReadonlyArray<ReferenceLinkRule> | undefined>(
  undefined,
);

export function ReferenceLinksProvider(props: {
  rules: ReadonlyArray<ReferenceLinkRule> | undefined;
  children: ReactNode;
}) {
  return <ReferenceLinksContext value={props.rules}>{props.children}</ReferenceLinksContext>;
}

/** The surrounding project's rules (raw, so they can cross into the MDX worker). */
export function useReferenceLinkRules(): ReadonlyArray<ReferenceLinkRule> | undefined {
  return use(ReferenceLinksContext);
}

export function useReferenceLinker(): ReferenceLinker | null {
  return compileReferenceLinks(use(ReferenceLinksContext));
}

/** Plain (non-markdown) agent text with the project's references linked. */
export function LinkifiedText({ text }: { text: string }) {
  const linker = useReferenceLinker();
  const segments = linker ? splitReferenceLinks(text, linker) : null;
  if (!segments) return text;
  return segments.map((segment) =>
    segment.url === undefined ? (
      segment.text
    ) : (
      <a
        key={segment.start}
        href={segment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
        onClick={(event) => event.stopPropagation()}
      >
        {segment.text}
      </a>
    ),
  );
}
