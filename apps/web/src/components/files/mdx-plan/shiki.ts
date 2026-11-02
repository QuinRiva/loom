import { useEffect, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

/**
 * Highlighting for plan code blocks, through the app's shared highlighter (the one code fences
 * use), so the MDX plan renderer never creates a second highlighter type on the thread.
 * Consumed by `<Code>` and `<AnnotatedCode>`.
 */

/** Highlight `code` to theme-aware HTML; returns `null` until the async load resolves. */
export function useShikiHtml(code: string, language: string): string | null {
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const [html, setHtml] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- highlights with the lazily loaded Shiki highlighter
  useEffect(() => {
    let active = true;
    void getSyntaxHighlighterPromise(language).then((highlighter) => {
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
