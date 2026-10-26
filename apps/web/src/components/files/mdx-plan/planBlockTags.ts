/**
 * Plan-block tag names, React-free so the worker's unknown-tag guard need not import
 * the DOM-touching registry. `planBlockTags.test.ts` asserts it equals the registry's tags.
 */
export const PLAN_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "AnnotatedCode",
  "Annotation",
  "Artboard",
  "Badge",
  "Callout",
  "Card",
  "Checklist",
  "Code",
  "Column",
  "Columns",
  "Connector",
  "DataModel",
  "Design",
  "DesignBoard",
  "Details",
  "Diagram",
  "Diff",
  "Endpoint",
  "FieldDiff",
  "FileTree",
  "Glossary",
  "HtmlBlock",
  "Image",
  "Json",
  "Mermaid",
  "OpenApi",
  "Prototype",
  "QuestionForm",
  "ReviewChoice",
  "Screen",
  "Section",
  "Stats",
  "Step",
  "Steps",
  "Tab",
  "Table",
  "TabsBlock",
  "Term",
  "VisualQuestions",
]);

/**
 * The only raw HTML tags that render, with every attribute stripped; anything else
 * becomes an error card, so a `<style>`, fixed overlay or remote `<iframe>` cannot
 * reach the app. Shared by the compile guard, the error card and the linter.
 */
export const ALLOWED_HTML_TAGS: ReadonlySet<string> = new Set([
  "span",
  "mark",
  "kbd",
  "sub",
  "sup",
  "small",
  "br",
]);

export const rawHtmlTagMessage = (tag: string) =>
  `Raw HTML <${tag}> is not rendered. Pills are <Badge>, grids are <Columns>/<Card>, a bespoke figure is <HtmlBlock>. Only ${[...ALLOWED_HTML_TAGS].map((name) => `<${name}>`).join(", ")} pass through, unstyled.`;
