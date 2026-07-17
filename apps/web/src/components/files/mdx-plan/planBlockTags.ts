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
  "HtmlBlock",
  "Json",
  "Mermaid",
  "OpenApi",
  "Prototype",
  "QuestionForm",
  "ReviewChoice",
  "Screen",
  "Section",
  "Tab",
  "Table",
  "TabsBlock",
  "VisualQuestions",
]);
