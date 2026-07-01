# Good vs. bad — a worked skeleton and named anti-patterns

Read this alongside `document-quality.md`, `wireframe.md`, and `canvas.md`. It is
the bar an authored plan must clear.

## A good plan skeleton (UI work)

A plan for adding a bulk-archive action to a contacts list reads, top to bottom:

1. **Objective + done-criteria** — one short paragraph: what ships, what "done"
   means. For this broad-ish change, one concrete `<Screen surface="browser">`
   snapshot of the current list right under it, so a reviewer sees the starting
   point before any mechanics.
2. **Scope / non-goals** — prose. What is in the first cut, what is deferred.
3. **The change, as a comparable pair** — a `<Columns>` block with
   `<Column label="Before">` and `<Column label="After">`, each holding a
   `<Screen>` of the list header: the After adds a selection checkbox column and
   an `Archive selected` action in the existing toolbar's top-right slot; every
   other control is preserved so the delta is obvious. No `Before`/`After` pill
   baked into either frame — the column headers name the states.
4. **The file map** — an `<AnnotatedCode>` of the one load-bearing file (the list
   component), with two or three margin notes on the lines that change; a
   `<FileTree>` naming the handful of touched files with change badges.
5. **The decision** — a `<Callout tone="decision">` stating the chosen approach
   (optimistic archive with undo), with a `<Columns>` weighing it against the
   alternative you rejected.
6. **Verification** — prose naming the end-to-end smoke: select two rows, archive,
   confirm they leave the list and the undo toast restores them.
7. **One `<QuestionForm>`** at the very bottom for the single genuinely-open
   decision, with a `recommended` default.

Nothing repeats: the `<Screen>` pair shows the UI, the prose and code carry the
depth the pictures can't.

## A good plan skeleton (backend / architecture work)

No visual surface. The document opens with the objective and a one-paragraph
recommendation, then repeats a section rhythm per change: a short title, a
`<DataModel>` or `<Endpoint>` next to the prose that needs it, an
`<AnnotatedCode>` of the load-bearing file, an inline `<Mermaid>` or `<Diagram>`
only where a real two-dimensional relationship (layering, data flow) clarifies
something, and terse Problem/Solution/Why prose in the codebase's vocabulary. It
closes with a verification step and a bottom `<QuestionForm>` only if the next
direction is genuinely open.

## Named anti-patterns (never produce these)

- **Hard-coded hex instead of tokens.** A wireframe `html` with
  `style="background:#fff;color:#111"` (or a `font-family`) — breaks in dark mode.
  Use `var(--wf-paper)` / `var(--wf-ink)` and never set a font.
- **Forced desktop + mobile.** Emitting a `desktop` frame _and_ a `mobile` frame
  for a change that is a popover or a panel. Pick the one surface that matches
  what the user sees.
- **A mockup dumped into `<HtmlBlock>`.** Escaping a screen into a raw-HTML block
  instead of a `<Screen>`/`<Design>` — you lose the surface footprint, the theme,
  the tokens, and node-level annotation. `<HtmlBlock>` is for a snippet the native
  blocks can't cover.
- **Marketing hero headings.** A giant landing-page heading, value props, or a
  "why this matters" card on a technical plan. Write outcome-first prose.
- **Before/After baked into the frame.** A `Before` / `After` pill, title, or
  heading inside the wireframe `html`. The `<Column label>` (or `<Artboard
caption>`) is the only place the state name belongs.
- **Overlapping artboards.** `browser` frames touch/overlap at any x-gap `<1800`
  board units (and have no clear gutter below `2200`) in our renderer, because a
  frame consumes ~2× its pixel width in board units. Use the x-gaps in `canvas.md`
  (≥ 2200 between browser frames; ≥ 1000 between compact `mobile`/`popover`/`panel`
  frames).
- **Product screen polluted with plan explanations.** A wireframe with repo pills,
  file-contract arrows, or architecture notes drawn inside the screen. Keep the
  screen pure; put those in a `<DesignBoard>` `<Annotation>`, a `<Diagram>`, or the
  prose.
- **A questions/decisions wall mid-document.** A second open-questions list, or a
  parallel "decisions" section above the bottom `<QuestionForm>`. There is exactly
  one questions block, at the very bottom.
- **A plan written as a changelog.** "Unlike the previous version…", "as discussed
  above…". Write the current proposal as a standalone document.
