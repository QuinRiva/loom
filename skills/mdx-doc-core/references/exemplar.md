# Skeletons and anti-patterns

Read this alongside `document-quality.md`. Each skeleton below is the order a
good document of that genre reads in, top to bottom, with what the first screen
holds spelled out — because the first screen is where these documents have most
often gone wrong. The example subjects are invented.

> **Placeholder — real exemplars to follow.** A later phase adds complete,
> real-content documents written under these skeletons and judged good by the
> human who reads them: one plan, one recap, one decision batch, one explainer,
> as `exemplar-<genre>.mdx` beside this file. Until they land, the skeletons
> are the bar; once they land, read the exemplar for your genre before the
> skeleton, and treat a conflict between them as the exemplar winning.

## A plan (UI work)

A plan for adding a bulk-archive action to a contacts list:

1. **First screen — the recommendation and what the user gets.** One
   paragraph: _add a selection column and an "Archive selected" action to the
   existing toolbar; optimistic archive with an undo toast; about a day, web
   only; the one bet is optimistic-with-undo over a confirm dialog._ Directly
   under it, the change as a comparable pair — a `<Columns>` with
   `<Column label="Before">` and `<Column label="After">`, each holding a
   `<Screen>` of the list header, every other control preserved so the delta
   is the only thing that differs. The column labels name the states; the
   frames carry no `Before`/`After` pill of their own.
2. **What it means** — two or three lines: what is in the first cut, what is
   deferred, and the one line pointing at the open question at the end.
3. **`## 1. The approach`** — a `<Callout tone="decision">` stating the chosen
   approach and why, with a `<Columns>` weighing it against the alternative
   you rejected, each side one short paragraph.
4. **`## 2. The changes`** — an `<AnnotatedCode>` of the one load-bearing file
   (the list component) with two or three margin notes on the lines that
   change; a `<Details summary="All touched files">` holding the `<FileTree>`
   with change badges.
5. **`## 3. Verification`** — prose naming the end-to-end smoke: select two
   rows, archive, confirm they leave the list and the undo toast restores them.
6. **One `<QuestionForm>`** at the bottom for the single genuinely open
   decision, with a `recommended` default.

Nothing repeats: the `<Screen>` pair shows the UI, the prose and code carry the
depth the pictures cannot.

## A plan (backend / architecture work)

No visual surface. The first screen is the recommendation and the bets it
settles — _one export queue instead of two; consumers subscribe by name rather
than by registration order; the wire format and ids unchanged; about two
days_ — followed by
a short objective-and-scope paragraph. Then one numbered section per change:
a `<DataModel>` or `<Endpoint>` beside the prose that needs it, an
`<AnnotatedCode>` of the load-bearing file, a `<Mermaid>` only where a real
two-dimensional relationship (layering, data flow) clarifies something, and
terse problem / solution / why prose with the codebase's names glossed on first
use. The file map sits in a `<Details>`. It closes with a verification section
and a bottom `<QuestionForm>` only if the next direction is genuinely open.

## A decision batch (recap genre)

A sign-off over N items — a taxonomy review, an audit, a PR-style review:

1. **First screen — the verdict with its numbers.** _"Of 42 proposed changes:
   30 apply as written, 9 apply once amended, 3 should be withdrawn."_ Then
   one line on what that means (_the 9 amendments are all one pattern —
   the condition was written as a rule where it is a hint_), then **one line
   of protocol**: an item left undecided takes its recommendation.
2. **`## 1. All items`** — a compact `<Table filterable>`, one row per item
   (subject, verdict class, recommendation), so the batch is scannable before
   the detail; `filterable` adds client-side filter and header-click sort.
3. **`## 2. The items`** — one `<Card>` per item: `tone` = verdict class,
   `badge` naming the class, `meta` chips for pack / confidence / recommended
   action. Inside, in order: one or two sentences of _why_; the decisive
   evidence as a `<FieldDiff>` (its null / absent / kept distinctions carry
   meaning); a `<Details>` holding the bulk evidence (full production entry,
   counterpart pack); a `<ReviewChoice itemId>` with an id unique in the
   document — a duplicate id silently collapses two widgets onto one decision.
   The renderer shows a sticky "N of M decided" counter whenever a document
   has `<ReviewChoice>` items.
4. **A bottom `<QuestionForm>`** for the genuinely balanced calls only
   (rollout strategy, a schema name) — not a second copy of the per-item
   decisions.

The renderer test fixture at `plans/mdx-review-blocks/plan.mdx` shows every
review block in situ; it is a fixture, not a model of the writing.

## A recap (recap genre)

A recap of a finished change — a branch, a thread's work, an incident:

1. **First screen — what the reader can now do, or what changed for them, with
   the number that proves it.** _"Duplicate reminders are gone from the daily
   digest: repeats down from about one in five to none on the seeded week; one
   endpoint removed, none added."_ Then what it means: what to check, what is still
   open, whether anything needs their decision.
2. **`## 1. Before and after`** — a `<Columns>` or `<Screen>` pair when the
   change touched rendered UI; otherwise the behaviour before and after in
   prose with one literal example each (the request that used to return X and
   now returns Y).
3. **`## 2. How it works now`** — the mechanism in the reader's terms, one
   example beside each piece; a `<DataModel>` / `<Endpoint>` beside the prose
   for any contract that changed.
4. **`## 3. The changes`** — the key changes as one horizontal `<TabsBlock>` of
   `<Diff>` / `<AnnotatedCode>`, three to eight tabs, about 150 lines per
   excerpt, each with a one-line summary and a few line notes; a
   `<ReviewChoice>` per tab when the recap doubles as a gate. The `<FileTree>`
   change map in a `<Details>`.
5. **`## 4. Still open`** — risks, follow-ups, and the one-line pointer to a
   bottom `<QuestionForm>` if a direction is genuinely open.

## An explainer (explainer genre)

A document whose job is to make the reader understand something — a system,
a change, a diagnosis — rather than to approve or decide:

1. **First screen — the summary.** What the thing is, in the reader's terms,
   and the one sentence they could use to explain it to someone else. For a
   diagnosis, the cause and the one number or example that pins it: _"The
   nightly job double-counts because two rows share a key the merge step
   assumed unique; 14 of 212 buildings are affected, and each shows the same
   signature."_
2. **`## 1. The mental model`** — the two to four pieces and how they relate:
   a `<Mermaid>` of at most about ten nodes, or a `<Columns>` of `<Card>`s one
   per piece, with a sentence under it saying how to read it.
3. **`## 2. How it works`** — one section per piece. Each gives the mechanism
   as _input → what happens → output_ and one literal example: a real input
   and what came out, a record before and after, a quoted line.
4. **`## 3. What this means for you`** — what to do next, what to watch, what
   is unaffected; a `<Callout tone="warning">` for the one thing that is
   urgent.
5. **`## 4. Open edges`** (optional) — what the explanation does not cover or
   what the evidence does not yet settle.

No review protocol. A `<QuestionForm>` or `<ReviewChoice>` appears only where a
decision genuinely rides on the explanation.

## Anti-patterns, and what each costs the reader

Communication:

- **Protocol first.** The first viewport spent on how to review ("silence
  means accept…") before the reader knows what is being decided. They scroll
  to find the answer, or stop.
- **The work objective as the opening.** _"The server has two connection
  pools, an in-process writer and a worker-thread reader…"_ — the writer's
  starting point, in the codebase's vocabulary.
  The recommendation is two screens down; the reader reaches it tired.
- **Insider register.** Thread ids, item codes ("M4", "D2 of the earlier
  plan"), "per the report", a section title used as a noun. The reader was not
  there; each one is a word they cannot resolve.
- **A claim with no example.** "The classifier over-triggers on amendments."
  Which amendment, saying what, classified as what? Without the instance the
  claim is a label.
- **Judgement written out where a badge exists.** Three sentences per option
  on strength, collision and cost, where `badge="RECOMMENDED"` and
  `meta={["client only", "no new RPC"]}` would carry it.
- **A plan written as a changelog.** "Unlike the previous version…", "as
  discussed above…". The reader has no previous version.
- **A jargon-gated question.** A bottom `<QuestionForm>` leaning on labels the
  document coined — "Yes, fold it into slice 1" — so a reader who skimmed the
  body cannot answer. Gloss in `subtitle` and name the outcome in the label:
  "Yes — build the meter in the same pass as the settings page". A `refs` chip
  lets them read the section; it does not carry the meaning the label left out.
- **A questions wall mid-document.** A second list of open questions, or a
  "decisions" section, above the bottom form. The reader meets the same
  question twice and does not know which to answer.
- **A marketing hero.** A landing-page heading, value props, a "why this
  matters" card on a document whose first paragraph already says why.

Renderer mechanics — these are facts about what the renderer does, not taste:

- **Hard-coded hex instead of tokens.** A wireframe `html` with
  `style="background:#fff;color:#111"` or a `font-family` breaks in dark mode;
  use `var(--wf-paper)` / `var(--wf-ink)` and leave the font alone.
- **A desktop and a mobile frame for a change that is a popover or a panel.**
  Pick the one surface the user actually sees.
- **A mockup in `<HtmlBlock>`.** It loses the surface footprint, the theme and
  the tokens that `<Screen>`/`<Design>` give it.
- **Before/After baked into the frame.** A pill, title or heading inside the
  wireframe `html` naming the state; the `<Column label>` (or `<Artboard
caption>`) is where the state name belongs.
- **Overlapping artboards.** `browser` frames touch or overlap at any x-gap
  under 1800 board units and have no clear gutter under 2200, because a frame
  consumes about twice its pixel width in board units. Use the gaps in
  `canvas.md` (≥ 2200 between browser frames; ≥ 1000 between compact
  `mobile`/`popover`/`panel` frames).
- **A product screen polluted with plan notes.** Repo pills, file-contract
  arrows or architecture notes drawn inside the screen. Keep the screen pure
  and put those in a `<DesignBoard>` `<Annotation>`, a `<Diagram>` or the prose.
