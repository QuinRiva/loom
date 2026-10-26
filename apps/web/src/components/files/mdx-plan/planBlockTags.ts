/**
 * The closed set of plan-block JSX tag names, as a React-free constant.
 *
 * The compile pipeline runs in a Web Worker (see `compileWorker.ts`), so the
 * unknown-tag guard cannot import the React block registry (`registry.tsx`) —
 * that pulls the whole component graph (and `document`-touching modules) into
 * the worker, which has no DOM. The guard only needs the tag *names*, so they
 * live here as plain strings. `planBlockTags.test.ts` asserts this set equals
 * the registry's actual tags, so the two cannot drift.
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
 * Raw lowercase HTML: the only tags that render, and those with every attribute
 * stripped (no `style`, no `class`, no `src`). Anything else lowercase becomes an
 * error card — a `<style>` sheet, a `position: fixed` overlay or a remote
 * `<iframe>` would otherwise reach the app. Shared by the compile guard
 * (`mdxCompileOptions.ts`), the error card (`registry.tsx`) and the linter.
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
  `Raw HTML <${tag}> is not rendered — pills are <Badge>, grids are <Columns>/<Card>, a bespoke figure is <HtmlBlock>. Only ${[...ALLOWED_HTML_TAGS].map((name) => `<${name}>`).join(", ")} pass through, unstyled.`;
