import {
  type DiffsHighlighter,
  getSharedHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { useEffect, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";

/**
 * Shared Shiki access for plan code blocks. Reuses the app's existing highlighter
 * (`@pierre/diffs` `getSharedHighlighter`) — the same one code fences use — so the
 * MDX plan renderer never bundles a second Shiki. Consumed by `<Code>` and
 * `<AnnotatedCode>`.
 */

const highlighterByLanguage = new Map<string, Promise<DiffsHighlighter>>();

/** Lazily load (and cache) a highlighter for one language, falling back to text. */
export function highlighterFor(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterByLanguage.get(language);
  if (cached) return cached;
  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((error) => {
    highlighterByLanguage.delete(language);
    if (language === "text") throw error;
    return highlighterFor("text");
  });
  highlighterByLanguage.set(language, promise);
  return promise;
}

/** Highlight `code` to theme-aware HTML; returns `null` until the async load resolves. */
export function useShikiHtml(code: string, language: string): string | null {
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void highlighterFor(language).then((highlighter) => {
      if (!active) return;
      try {
        setHtml(highlighter.codeToHtml(code, { lang: language, theme: themeName }));
      } catch {
        setHtml(highlighter.codeToHtml(code, { lang: "text", theme: themeName }));
      }
    });
    return () => {
      active = false;
    };
  }, [code, language, themeName]);

  return html;
}
