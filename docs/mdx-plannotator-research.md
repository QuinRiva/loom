---
manager_sessions:
  - id: af403c17-b087-4184-9ff4-dafadd4839f1
    role: research
    authored_at: 2026-06-30T23:59:43.109Z
---

# Research: plannotator anatomy & first-party MDX support for annotated plans

Read-only investigation of the existing "plannotator" feature and what it would
take to pivot plan authoring to **MDX** (BuilderIO `/visual-plan` block model)
while keeping a span-anchored comment workflow. All claims are grounded in
`file:line` evidence from the `t3code` worktree at
`/home/Carl/.t3/cockpit/worktrees/loom/t3code-7a84187d`.

---

## ⚠️ Top-line correction to the brief's premise

The brief states the current feature renders markdown "(not raw)" and lets a
reviewer "highlight passages and attach comments" **on the rendered document**.
That is **not** how it works today.

`FilePreviewPanel` has **two mutually-exclusive surfaces** behind an Eye/Code
toggle (`apps/web/src/components/files/FilePreviewPanel.tsx:651-704`):

- **`EditableFileSurface` (the DEFAULT)** — a line-numbered _source_ editor
  built on `@pierre/diffs` (`File`/`Editor`/`Virtualizer`). This is the surface
  that supports highlight → comment. Annotations anchor to **integer line
  numbers**.
- **`RenderedMarkdownSurface` (opt-in via the Eye toggle)** — renders the
  markdown through `ChatMarkdown`. It has **no annotation capability** at all;
  its only interactivity is toggling task-list checkboxes
  (`FilePreviewPanel.tsx:467-505`).

The default is source view: `markdownView` initialises to `{path: null}`
(`FilePreviewPanel.tsx:566`) and `renderMarkdown` is only true once the user
presses the toggle (`FilePreviewPanel.tsx:575-579`, toggle at `:621-651`).

**Consequence for the pivot:** there is no existing "annotate rendered prose"
mechanism to preserve. The annotation feature is line-based on source text. The
pivot therefore is _not_ "keep span annotation working as the doc gets richer" —
it is "**build rendered-content span annotation for the first time**, on a
format (MDX) that the app cannot currently render." That is a materially larger
scope than the brief frames.

---

## Q1. Annotation anchoring mechanism

**Anchor = a normalised integer line range over the source text.** There are no
DOM ranges, element ids, character offsets, or text-content anchors.

Core data structures — `apps/web/src/components/files/fileCommentAnnotations.ts`:

```ts
export interface FileCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  startLine: number;
  endLine: number;
  text: string;
}
export type FileCommentLineAnnotation = LineAnnotation<FileCommentAnnotationGroup>;
```

`LineAnnotation` comes from `@pierre/diffs`; it carries a `lineNumber` plus the
`metadata` group above. Selection is a `SelectedLineRange` (`{ start, end, side,
endSide }`) emitted by the `@pierre/diffs` editor.

Anchoring/lifecycle logic lives in `EditableFileSurface`
(`FilePreviewPanel.tsx:283-470`):

- `onLineSelectionEnd` → `handleLineSelectionEnd` → `beginComment(range)` creates
  a `draft` entry at `endLine` (`FilePreviewPanel.tsx:392-435`).
- Submitting calls `buildFileReviewComment({ startLine, endLine, contents, … })`
  and pushes it to the composer store (`FilePreviewPanel.tsx:312-339`,
  `:350-388`).
- `normalizeFileCommentRange` clamps `start/end`
  (`fileCommentAnnotations.ts:24-33`).

**Robustness to re-render / edits — weak and line-shift-naive.** When the source
is edited, the editor re-emits annotations and `remapFileCommentAnnotations`
_re-pins each entry to the annotation's current `lineNumber`_, preserving only
the original line _span length_:

```ts
// fileCommentAnnotations.ts:43-58
const lineCount = entry.endLine - entry.startLine;
return {
  ...entry,
  endLine: annotation.lineNumber,
  startLine: Math.max(1, annotation.lineNumber - lineCount),
};
```

So anchors track the editor's own line bookkeeping, not document content. There
is no content hash, no fuzzy text re-matching, no AST node identity. Edits far
from the comment that change line counts will drift the anchor. This model is
**fundamentally tied to a line-oriented source view** and has no meaning over
rendered/compiled component DOM.

---

## Q2. Feedback assembly + injection (fully built)

The path from annotation to an injected user turn is complete and runs over the
**ordinary message-send flow** — there is no dedicated annotation WS message.

1. **Store.** Each submitted comment becomes a `ReviewCommentContext` and is
   added to the composer draft via `addReviewComment`
   (`composerDraftStore.ts` — interface at `:~/addReviewComment`,
   `reviewComments` slice persisted in `PersistedComposerThreadDraftState`).
   `buildFileReviewComment` (`apps/web/src/reviewCommentContext.ts:~/buildFileReviewComment`)
   produces:

   ```ts
   { id, sectionId: `file:${filePath}`, sectionTitle: "File comment",
     filePath, startIndex: startLine-1, endIndex: endLine-1,
     rangeLabel: "L.. to L..", text, diff: selectedLines.join("\n"),
     fenceLanguage: <ext> }
   ```

   Note the captured evidence (`diff`) is the **literal selected source lines**.

2. **Send-time assembly.** On send, `ChatView` folds the comments into the
   prompt text (`apps/web/src/components/ChatView.tsx:4056-4059`):

   ```ts
   const messageTextForSend = appendReviewCommentsToPrompt(
     messageTextWithPreviewAnnotations,
     composerReviewCommentsSnapshot,
   );
   ```

   `appendReviewCommentsToPrompt` / `formatReviewCommentContext`
   (`reviewCommentContext.ts`) serialise each comment to an XML-ish block:

   ````
   <review_comment sectionId="…" sectionTitle="…" filePath="…"
       startIndex="N" endIndex="M" rangeLabel="…">
   <comment text>
   ```<lang>
   <selected source lines>
   ````

   </review_comment>

   ```

   These blocks are appended to the user's prompt and sent as a **normal user
   turn**. The same module can parse them back
   (`parseReviewCommentMessageSegments`) for timeline rendering
   (`MessagesTimeline.tsx`, `ChatView.tsx:183`).

   ```

3. **WS contract.** No bespoke RPC — it rides the existing prompt/message send.
   The only annotation-specific contract is the `ReviewCommentContextSchema`
   effect/Schema (`reviewCommentContext.ts`), persisted in composer drafts.

**Status: fully built and wired**, including a sibling diff-review path
(`buildDiffReviewComment` / `restoreDiffReviewCommentRange`) used by
`AnnotatableCodeView` for diffs, which keys on diff hunk line indices.

---

## Q3. File read surface (fully built)

- **Contract:** `WS_METHODS.projectsReadFile = "projects.readFile"`
  (`packages/contracts/src/rpc.ts:156`), `WsProjectsReadFileRpc`
  (`rpc.ts:382-386`). Payload `ProjectReadFileInput {cwd, relativePath}`; success
  `ProjectReadFileResult {relativePath, contents, byteLength, truncated}`
  (`packages/contracts/src/project.ts:119-131`). Write side mirrors it
  (`projects.writeFile`, `rpc.ts:388-391`, `project.ts:190-200`).
- **Client:** `projectEnvironment.readFile` atom, wrapped by
  `useProjectFileQuery` with an optimistic overlay
  (`apps/web/src/components/files/projectFilesQueryState.ts:33-44`, `:~/useProjectFileQuery`).
- **Server:** `WorkspaceFileSystem.readFile`
  (`apps/server/src/workspace/WorkspaceFileSystem.ts:135-243`) reads up to a
  **1 MB cap** (`PROJECT_READ_FILE_MAX_BYTES = 1024*1024`, `:28`), decodes UTF-8,
  and sets `truncated: stat.size > 1MB` (`:241-243`). The panel shows a "first
  1 MB" banner when truncated (`FilePreviewPanel.tsx:`).

This contract is **format-agnostic** — it returns raw text for any path, so it
already serves `.mdx` files unchanged. `isMarkdownPreviewFile` already matches
`.mdx` (`filePreviewMode.ts:1`).

---

## Q4. Rendering stack (`ChatMarkdown`)

`apps/web/src/components/ChatMarkdown.tsx` — a **`react-markdown@10`** renderer,
not MDX:

```tsx
// imports
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

// render (bottom of file)
<ReactMarkdown
  remarkPlugins={
    lineBreaks
      ? [remarkGfm, remarkBreaks, remarkPreserveCodeMeta]
      : [remarkGfm, remarkPreserveCodeMeta]
  }
  rehypePlugins={[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]}
  components={markdownComponents}
  urlTransform={markdownUrlTransform}
>
  {text}
</ReactMarkdown>;
```

Pipeline characteristics:

- **CommonMark + GFM only.** No JSX/component parsing. Custom _block components_
  (the BuilderIO model) would render as literal text or be stripped.
- **Security via allow-list sanitisation.** `rehypeRaw` (parse raw HTML) →
  `rehypeSanitize` with a customised `defaultSchema`
  (`CHAT_MARKDOWN_SANITIZE_SCHEMA`, `ChatMarkdown.tsx:~/CHAT_MARKDOWN_SANITIZE_SCHEMA`).
  This is an HTML-tag/attribute allow-list, the opposite discipline to executing
  arbitrary MDX.
- **Component overrides** via react-markdown's `components` map: `p`, `li`,
  `input` (task checkboxes → `onTaskListChange`), `a` (file-link/thread chips,
  fragment scroll), `table`, `details`, `pre` (Shiki code highlight). These map
  **standard HTML tags**, not custom MDX elements.
- A small custom remark plugin `remarkPreserveCodeMeta` threads code-fence meta
  through to `data-code-meta`.

**Migration implication:** to render MDX you cannot extend this pipeline
incrementally — react-markdown does not execute MDX/JSX. You need a separate MDX
compile+eval path (`@mdx-js/mdx` `evaluate`/`run`, or a build-time compile) with
a `components` registry, and a different safety model than `rehype-sanitize`.

---

## Q5. MDX gap analysis

**Existing MDX deps in the repo: none.** `apps/web/package.json` has
`react-markdown@^10.1.0`, `rehype-raw`, `rehype-sanitize`, `remark-breaks`,
`remark-gfm` — and **no** `@mdx-js/*`, `next-mdx`, `mdx-bundler`, `@mdx-js/rollup`,
etc. (verified: only `apps/web/package.json` matches any `mdx|remark|rehype`
token across all `package.json`s, and it lists none of the MDX packages).

### (a) Compile & render MDX in-browser with a safe component registry

- **Compiler.** Add `@mdx-js/mdx`. Two options:
  - _Runtime_: `evaluate(source, { ...runtime, useMDXComponents })` — compiles
    in the browser. Flexible (plans are user/agent-authored files that change),
    but executes arbitrary code.
  - _Build-time_: `@mdx-js/rollup` — safer, but plans are **workspace files read
    at runtime** via `projects.readFile`, so build-time compile doesn't fit the
    "open any plan file in the panel" model. **Runtime compile is the likely
    path.**
- **Safety.** This is the hard security problem. `rehype-sanitize` cannot guard
  executed MDX. The realistic model is: **disallow arbitrary JSX/expressions**,
  compile in a constrained mode, and render only through a **fixed allow-listed
  component registry** (no `import`, no raw `{expression}` escape hatches). MDX's
  freedom is the threat; the BuilderIO block set is finite, so a closed registry
  - remark/rehype guards that reject unknown elements is the tractable approach.
- **Registry.** A `Record<string, React.ComponentType>` mapping the BuilderIO
  block tags (see Q6) to local React implementations, passed as MDX
  `components`. This is net-new UI work (wireframe renderer, diagram, data-model,
  api-endpoint, annotated-code, json-explorer, tabs, question-form, …).

### (b) Keeping span-anchored annotation over component-rich MDX

This is the crux, and the current mechanism **cannot survive** arbitrary
component DOM:

- Today's anchor is `startLine`/`endLine` over source text rendered by a
  line-numbered editor (`@pierre/diffs`). Compiled MDX has no stable line grid;
  a single source line can expand into a whole interactive component subtree, and
  a wireframe/diagram has no "lines" at all.
- Anchoring must move to **a new layer**. Plausible layers, roughly in
  increasing difficulty:
  1. **Per-block comment slots** keyed by **MDX-AST/block id.** Easiest and
     robust: every top-level block gets a stable id (BuilderIO already assigns
     block ids); comments attach to a whole block. Survives re-render and most
     edits. Loses sub-span precision inside prose.
  2. **DOM-range + text-quote anchors** for prose blocks (à la web annotators /
     plannotator.js): store `textQuote` + `contextBefore/After` and re-resolve
     against rendered text. Matches BuilderIO's `textQuote` anchor model. Fragile
     inside components; needs fuzzy re-matching after edits.
  3. **Component-internal node anchors** (e.g. a wireframe kit node id/path, a
     specific table cell). Matches BuilderIO's `targetNodeId`/`targetNodePath`.
     Requires each registry component to expose annotatable node identity.
- **Injection contract impact.** `<review_comment>` currently carries
  `startIndex`/`endIndex` (line indices) + a diff fence of selected _source
  lines_ (`reviewCommentContext.ts`). For MDX, the "selected evidence" is no
  longer a clean line slice — it's a block id / quoted text / node path. The
  serialisation schema (`ReviewCommentContextSchema`) and
  `format/parseReviewCommentContext` would need to evolve to carry the richer
  anchor, or a parallel anchor type introduced.

**Net:** reuse of the _injection plumbing_ (composer store →
`appendReviewCommentsToPrompt` → user turn) is realistic; reuse of the
_anchoring layer_ (`@pierre/diffs` line selection + `LineAnnotation` +
`remapFileCommentAnnotations`) is **not** — rendered-MDX annotation is greenfield.

---

## Q6. BuilderIO `/visual-plan` component model (quick read)

Source: `/tmp/pi-github-repos/BuilderIO/skills@main/skills/visual-plan/`
(`SKILL.md` + `references/{local-files,canvas,wireframe,document-quality,…}.md`).

**Artifact shape.** Plans are portable MDX folders: `plan.mdx`, optional
`canvas.mdx`, optional `prototype.mdx`, optional `.plan-state.json`, plus
JSON/HTML exports. Local-files mode writes exactly this folder
(`references/local-files.md`).

**Block model.** Blocks are custom components authored in MDX, resolved from a
**live registry** via the `get-plan-blocks` tool (the skill is emphatic: _"do not
author from memorized tags … call `get-plan-blocks` first"_). The block set
referenced across the skill: `diagram`, `data-model`, `api-endpoint`,
`openapi-spec`, `diff`, `file-tree`, `code`, `annotated-code`, `json-explorer`,
`tabs`, `checklist`, `question-form`, `custom-html`, plus the canvas surfaces
`WireframeBlock`/`<Screen surface=… html={…}/>` and `prototype`. Whitespace-
sensitive blocks (`Code`/`AnnotatedCode`/`Diff`) encode multiline content as JSON
string attributes (`code={"const x =\n  y"}`).

**Annotation/anchor model (BuilderIO's own).** Far richer than t3code's line
anchors — from `SKILL.md` "Interpreting comment anchors":

- block ids; wireframe **`targetNodeId`/`targetNodePath`** (e.g.
  `card > list > listItem "Acme Inc"`);
- **`textQuote` + `contextBefore`/`contextAfter`** for prose (with an
  `ambiguous` flag);
- canvas coords (`canvasX/Y` board pixels; `targetX/Y` % within element; bare
  `x/y` % of document);
- detached-comment reconciliation; two-axis consumed/resolved state.

**Host assumption — important.** The skill assumes a **hosted Plan app** (the
`plan` / legacy `agent-native-plans` MCP connector at
`plan.agent-native.com`) that _owns_ rendering, commenting, feedback
(`get-plan-feedback`), and updates (`update-visual-plan`). Even local-files mode
"opens the hosted Plan UI but reads from a localhost bridge" — the **renderer is
still BuilderIO's**, only the data stays local. The agent authors MDX; it does
**not** render or annotate it itself.

**Therefore:** to get plannotator-on-MDX _inside t3code_ we would **reimplement
the renderer and annotation layer locally**. The reusable, host-independent parts
are: (1) the **MDX block schema** (discoverable via the no-auth `get-plan-blocks`
catalog / bundled `references/*.md`), and (2) the **MDX folder file contract** —
which t3code's `projects.readFile`/`writeFile` already serve. We would _not_
adopt the hosted MCP tools, the hosted comment store, or BuilderIO's renderer.

---

## Key tensions / open design decisions

1. **Anchoring layer for rendered MDX.** Per-block id slots (robust, coarse) vs.
   DOM-range/text-quote (precise prose, fragile) vs. component-internal node ids
   (matches BuilderIO wireframe pins, most work). Decide the layer _and_ its
   re-render/edit survivability story. The current line-based anchor is dead on
   arrival here.
2. **Reuse vs. replace the annotation layer.** The injection plumbing (composer
   `reviewComments` → `appendReviewCommentsToPrompt` → user turn) is reusable;
   the `@pierre/diffs` line-selection + `LineAnnotation` + `remap…` layer is not.
   Confirm we're building a new rendered-content annotation surface rather than
   adapting the source editor.
3. **Runtime vs. build-time MDX compile + the security model.** Plans are
   runtime-read workspace files, pushing toward runtime `@mdx-js/mdx` eval — but
   that breaks the `rehype-sanitize` safety model. Decide the constrained-compile
   - closed-registry approach and whether arbitrary `{expressions}`/imports are
     forbidden.
4. **Own renderer + fixed component registry vs. embedding BuilderIO.** Building
   the block components (wireframe, diagram, data-model, api-endpoint,
   annotated-code, json-explorer, tabs, question-form, …) is significant net-new
   UI. Alternative: embed BuilderIO's hosted/local app — but that surrenders the
   in-app plannotator UX and the `<review_comment>` injection contract.
5. **Evolving the `<review_comment>` injection schema.** Today it carries line
   indices + a diff fence of source lines. Rich MDX anchors (block id / node path
   / text quote) don't fit that shape; decide whether to extend
   `ReviewCommentContextSchema` or add a parallel MDX-anchor type, and what
   "evidence" the agent receives in the prompt.
6. **Annotation granularity.** Whole-block comments (easy, robust, ships fast)
   vs. arbitrary sub-spans inside interactive components (matches plannotator
   intent, much harder). This single choice drives most of the cost in #1.

---

## File reference index

| Concern                                   | Path                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Two-surface panel, toggle, default=source | `apps/web/src/components/files/FilePreviewPanel.tsx`                                 |
| Line-annotation data structures + remap   | `apps/web/src/components/files/fileCommentAnnotations.ts`                            |
| Comment form UI                           | `apps/web/src/components/files/LocalCommentAnnotation.tsx`                           |
| `.md`/`.mdx` detection, task-check edit   | `apps/web/src/components/files/filePreviewMode.ts`                                   |
| Review-comment build/serialise/parse      | `apps/web/src/reviewCommentContext.ts`                                               |
| Composer draft store (`reviewComments`)   | `apps/web/src/composerDraftStore.ts`                                                 |
| Send-time injection                       | `apps/web/src/components/ChatView.tsx:4056`                                          |
| Markdown renderer (react-markdown)        | `apps/web/src/components/ChatMarkdown.tsx`                                           |
| File read/write client query              | `apps/web/src/components/files/projectFilesQueryState.ts`                            |
| WS RPC contracts                          | `packages/contracts/src/rpc.ts:382-391`, `packages/contracts/src/project.ts:119-200` |
| Server file read (1 MB cap)               | `apps/server/src/workspace/WorkspaceFileSystem.ts:28,135-243`                        |
| BuilderIO skill                           | `/tmp/pi-github-repos/BuilderIO/skills@main/skills/visual-plan/`                     |
