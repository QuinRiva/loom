# Document quality bar

Shared by every MDX-document genre — plans (`mdx-visual-plan`), recaps and
decision batches (`mdx-visual-recap`), explainers (`mdx-visual-explainer`). The
genre `SKILL.md` carries the trigger, the skeleton and the genre's own
discipline; this file carries what does not vary: who the document is for, how
it is ordered, how judgement and evidence are shown, and the check before
handoff. Read it before drafting the body of any document. Everything here is
a default with its reason attached; when a document is better served another
way, take that way — the reasons are there so you can tell when.

## 1. Start with the reader, not the work

Most of these documents are read by someone who was not in the conversation
that produced them and has read none of the reports behind them; a child thread
writing from a brief has never met its reader at all. An explainer written in
conversation gets its reader contract for free — the person asking says, in
their own words, what they want to understand. A document written cold gets
nothing unless you write it down. So before drafting, write three lines into
the document's frontmatter:

```yaml
---
reader:
  who: the system's owner, deciding whether to fund the next round of work
  knows: the product and its review panel; none of the research behind this document
  after_first_screen: which cause dominates, and whether the cheap fixes are worth doing now
---
```

- `who` — the person, by role and situation rather than name, and what they
  are there to do: decide, approve, understand, re-orient.
- `knows` — what they already hold and what they do not: the chat you had,
  the child reports, the codebase's names, the earlier plan.
- `after_first_screen` — the sentence they should be able to say, or the
  decision they should be able to make, having read only the first screen.

The renderer hides frontmatter; these lines are for you and for the lint. What
the reader sees is the first screen you then write _for that reader_. If the
request does not say who reads, ask whoever made it before guessing (in a
workstream, your parent via `mcp__t3-code__consult_thread`); if nobody can
say, write for the human who owns the goal and record that assumption in `who`.

## 2. The first screen is the answer

Open with what the reader came for, in this order:

1. **The answer** — the recommendation, the verdict with its numbers, the
   headline finding. _"Of 42 items, 30 apply as written, 9 need amending and 3
   should be withdrawn."_ _"Recommend one export queue instead of two: about a
   day's work, and it removes the second path that produced both duplicates."_
2. **What it means for them** — the consequence, what changes, what they are
   being asked to do.
3. **The evidence** — causes, mechanism, per-item detail — in the numbered
   sections that follow.

The paragraph directly under the title renders as the lede — a step up from
body text — so it holds the answer; a version line, a date or a sources note
placed there becomes the most prominent text on the page. Those go in the
`kicker:` frontmatter line above the title, or in a `######` line, which the
renderer styles as the document's small muted text (provenance, a sources
footer) rather than as a sixth heading.

When the answer has numbers — a count, a duration, a share — the lede states
them and a `<Stats>` strip right under it shows them, one tile per number,
toned by what the number means: the eye takes in four figures in a row faster
than it finds them in a paragraph. A tile earns its place when its number is
part of the answer — what is affected, how long it hurt, what share; a
constant the reader looks up once (a tick interval, a default limit) reads
better in the sentence that uses it, and an answer that is a set of cases
rather than a quantity is shown as the cases (a `<Columns>` of toned
`<Card>`s), because a strip of incidental numbers takes the first screen's
best position from the answer. Bold the few words a skimming reader should
stop on — the case names, the deciding number; a whole bolded clause reads as
body text again. The consequence (item 2) is a
`<Callout focus title="What it means now">` directly under the lede or the
strip, not a bold run-in inside the lede — a run-in is read as part of the
summary, a titled box is read as the section it is.

Everything that is _about the document_ rather than about the subject comes
after the answer. The review protocol ("an item left undecided takes its
recommendation") is one line after the verdict, not the opening callout. The
objective and scope of the work are a short paragraph after the recommendation,
not before it. The file map, the diff tabs and the raw records sit in
drill-downs (`<Details>`) or in the last sections. The reason: a reader decides
in the first viewport whether to keep reading, and a viewport spent on protocol,
or on the codebase's vocabulary, is spent before they know what the document
says. The documents that have read best in this vocabulary all open this way;
the ones that read worst opened with the review protocol or the work objective.

The test, applied before handoff: **a reader who has read nothing can state the
conclusion and their decision from the first screen.** If they cannot, the
first screen is holding something else.

## 3. Hierarchy: overview before detail

- **Number the sections** (`## 1. The causes`, `## 2. Evidence, one example per
cause`). A long document needs a spine the reader can hold and a question can
  point at; numbers are the cheapest one.
- **Overview before detail.** The first section after the answer gives the whole
  picture at the altitude of a table or a short ranked list — causes ranked,
  options compared, items triaged — and the sections after it take one row
  each. Detail that would push the overview below the fold goes under it in a
  drill-down.
- **One literal example beside each claim.** A rule, cause, risk or mechanism
  gets one concrete instance next to it: the sentence as it was written, the
  record as it was stored, the screen as it looks today — quoted or shown, not
  described. Readers of these documents have said that abstract explanations
  without a worked example are meaningless to them; one example per claim is
  what turns a label into something they can picture.
- **Facts as fields, not prose.** A passage carrying more than two or three
  facts the reader must hold together — values, dates, parties, sources —
  is a compact `<Table>` or a field list, each fact with where it came from
  and as of when, and a fact the reader will want that nobody recorded stated
  as unknown. A paragraph of facts is re-derived by every reader; a table is
  read once, and the source column answers "where does this come from"
  before it is asked.
- **Judgement rides the block, not the sentence.** Where a verdict, state or
  class fits a `<Card>` `tone`, `badge` or `meta` chip, a `<Callout>` tone or a
  table column, put it there and let the prose carry the _why_. A badge reading
  `RECOMMENDED · fix now` with meta chips `client only`, `no new RPC` is taken
  in at a glance; the same content as three sentences per item is read slowly,
  or not at all. Colour alone does not carry meaning (the badge or heading
  names the class), but colour is what lets a batch be triaged before it is read.
  A state or verdict that recurs through the document — `in place`, `moot`,
  `lost`; `OURS`, `THEIRS` — is a `<Badge>` the first time and every time, so
  the reader learns the colour once and finds every occurrence by eye. In a
  table, that state is a badge cell and the rows that need finding carry a
  tone — a reader should locate the lost item by colour before reading a word
  of the table. When the document is organised around a few classes (the
  outcomes, the severities), each class keeps one tone in every block it
  appears in — cards, diagram nodes, table badges, step markers — and two
  classes share a tone only where the reader should treat them the same: the
  colour then becomes a key learned once, and a merge that is convenient for
  the writer costs the reader a distinction they needed.
- **Emphasis where it earns it.** A toned callout for the one thing that is
  urgent, a card per option, bold on the number that decides: these are how the
  main idea is made obvious in the first viewport, and they belong in a serious
  technical document. The register to leave out is marketing — a hero heading,
  a slogan, a "why this matters" card on a document whose first paragraph
  already says why — because it adds weight without information.
- **Gloss in the body, not only in the question form.** A document coins labels
  as it goes — a phase number, an item id, a thread id, a codename, a section
  title used as a noun — and the reader did not sit through the coining. The
  first use in prose carries the plain-words meaning in the same sentence
  ("the fan-in deadlock — two threads each waiting for the other to finish"); a thread id or report label is replaced by what it refers to
  ("the reviewer thread", "the earlier research found …") rather than cited.
  This is the rule that already governed `<QuestionForm>` fields, extended to
  the body, because the body is where the reader meets the label first. A
  numbered-section reference ("the evidence is in §5") is the sanctioned
  cross-reference: the number is on the page, so it resolves without a lookup.
  A word that means two things in one passage (the key's _row_, the rule's
  _row_) is glossed or replaced, because the reader cannot tell which is meant.

## 4. Choose the representation

Match the content to the representation that reads fastest, then consult
[`block-schema.md`](block-schema.md) for the exact props. A block where
structure beats a sentence; a sentence where it does not; and the block placed
directly beside the prose it supports, not in a gallery at the end.

| Content                                 | Representation                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The answer and its numbers              | Lede paragraph with the numbers in bold; a `<Callout>` for the one urgent thing                                                                                                                                                                                     |
| Options or causes compared              | `<Table>` for the overview, a `<Card tone badge meta>` per option for the detail: `success` + `RECOMMENDED` on the pick, `neutral` + `REJECTED` / `DEFERRED` on the rest, since a red card makes the reader look for a danger that a rejected option does not carry |
| Rules tested in order, first match wins | A one-line chain (`a` → X; `b` → Y; …) or a `<Steps>` ladder (`at` = 1…n, `badge` = the result) first, then the full matrix as a `<Table>`: the order is the mechanism, and a matrix states it without showing it                                                   |
| A few fields of a record change         | `<FieldDiff>`                                                                                                                                                                                                                                                       |
| Line-oriented source change             | `<Diff>`                                                                                                                                                                                                                                                            |
| N similar items each needing a verdict  | `<Card tone>` per item + `<ReviewChoice>` + summary `<Table filterable>`                                                                                                                                                                                            |
| Bulk evidence / full records            | `<Details>` + `<Json>`/`<Code>` inside, `wrap` for prose-heavy values                                                                                                                                                                                               |
| Balanced judgement calls (few)          | bottom `<QuestionForm>` with `recommended`                                                                                                                                                                                                                          |
| Typed entities / API ops / change map   | `<DataModel>` / `<Endpoint>` / `<FileTree>` (the map in a `<Details>`)                                                                                                                                                                                              |
| Before / after, current / target        | `<Columns>` with labelled columns, each side holding real blocks; a table wider than three or four columns is stacked rather than paired, since each side gets half the width even when the row takes the panel's full width                                        |
| A load-bearing file                     | `<AnnotatedCode>` with a few margin notes on the lines that change                                                                                                                                                                                                  |
| A sequence in time or in stages         | `<Steps>`, one `<Step>` per moment, tone on the ones that went wrong                                                                                                                                                                                                |
| Genuine 2-D structure                   | `<Diagram>` / `<Mermaid>`, about ten nodes at most                                                                                                                                                                                                                  |

A table of times is not a timeline: a reader scans a rail, not a column of
wrapped timestamps. Moments in order — a timeline, a ladder of options, a
pipeline's stages — are a `<Steps>` rail even when each carries three facts.
A table row whose cells run past three or four lines wants to be a `<Card>`
— a badge for the class, a `>` quote of the contested text with its source,
then the finding — with a one-line-per-row index table kept only when the
batch is long: long cells in a narrow grid get read column by column, not row
by row.

When no block carries what the content needs — a device the vocabulary lacks
— say so in place as one italic line, `*Vocabulary gap — what was wanted, and
what stands in for it.*`, where the gap occurs: one form lets whoever
maintains the vocabulary scan a document for them, and the reader learns why
that passage is weaker than it could be.

Four distinctions that are often got wrong:

- **`<FieldDiff>` vs `<Diff>`.** A change to a few fields of a record or config
  is a `<FieldDiff>`: it wraps long values and aligns them per field. `<Diff>`
  is for line-oriented source. A JSON string in a line diff is one
  horizontally-scrolled line, twice, and is what `<FieldDiff>` exists to retire.
- **A before/after vs two readings.** `<FieldDiff>`'s panels are a change —
  current → proposed, as keyed → recommended — and a reader meets them as
  before/after whatever the labels say. Two parties' conclusions about the
  same record are readings, not a change: a `<Table>` with a column per party
  (its name, basis and date in the header, outcomes as badges) or a
  `<Columns>` pair, so no direction is implied.
- **A card per item vs one flat list.** When a document reviews N similar items
  each needing a verdict, each gets its own `<Card tone>` so the batch can be
  triaged by colour before it is read, with the evidence and the decision
  surface inside the card.
- **An overview diagram vs one diagram for everything.** A diagram earns its
  place by showing a real two-dimensional relationship — layers, data flow,
  state — rather than a left-to-right chain the prose already states, and
  readability of a `<Mermaid>` graph collapses past about ten nodes: draw the
  five-to-eight-node overview, then a card or section per node for the
  detail. `<Diagram>` is a constrained `nodes`/`edges` + `x`/`y`% model;
  `<Mermaid>` auto-lays-out a flow, sequence or ER graph, and a rich layered
  picture is often clearer in `<Mermaid>` or prose than forced into `<Diagram>`.
  Tone the two or three nodes the reader should look at first (`:::tone-risk`)
  and leave the rest untoned, with a `legend` that names the colours: a graph
  where every node is the same grey makes the reader search for the point, and
  one where every node is coloured does the same.

## 5. Keep the altitude the reader asked at

A motivating example is not automatically the architecture. When the request
describes a broader framework, product mode or reusable primitive, separate the
reusable core from the specific app, provider or example: use the example to
make the document concrete, then say which parts are core, which are adapters
and which are future examples. For UI work the UI story lives in the visual
surface (`<Screen>`, `<DesignBoard>`, `<Prototype>` when the flow must be
operable) and the prose carries what the picture cannot — contracts, phases,
risks, verification — so the two do not repeat each other. A document with no
UI simply has no visual surface.

## 6. Decisions: settled ones in prose, open ones in one form at the bottom

A decision you have made is settled prose or a `<Callout tone="decision">`,
optionally with a `<Columns>` weighing the option you rejected — not a form
asking a question you have already answered. A one-line pointer in the first
screen ("two open questions at the end: rollout order and the schema name") is
welcome; the questions themselves live in one `<QuestionForm>` at the end, so
the reader meets them once, with the whole document behind them, rather than as
a second list part-way through.

Use `single`/`multi` for clear choices, `freeform` for constraints, and mark the
option you would pick `recommended: true`. For a write-in option set
`allowOther: true` (the renderer supplies the field; automatic for `freeform`).
A long document with no open questions is fine when every meaningful decision
has been made in it.

**Every question stands alone.** It is answered by someone who read the first
screen and skimmed the rest, so a question `title`, `subtitle`, option `label`
or option `detail` that uses a label the document coined says what it means in
the same sentence (§3, gloss). `subtitle` is the context slot: one sentence
saying what the question turns on. `refs: [{ label, anchor }]` — usually one,
at most four — chips the section a question depends on open beside it (`label`
is the heading as written, `anchor` its slug: lowercased, runs of
non-alphanumerics → `-`, so `## Delivery order` → `delivery-order` and
`## 1. The causes` → `1-the-causes`). Refs name
headings, not blocks, and supplement the wording; a reader who does not open
the chip still has to be able to answer. An option label states the outcome
the reader commits to by clicking — "Yes — register the hub first as a
settings-only step" rather than "Yes — slice 0".

## 7. Self-contained, whatever the size

A reader decides every item without leaving the document. Evidence a decision
depends on — the production record, the raw pack, the log, the before/after —
is embedded, behind a `<Details>` drill-down when bulky, rather than pointed at
in a companion file; the document that said "see the attached HTML for the
before/after" was the one that lost its reader. Size is not a reason to link
out: `.mdx` compiles off the main thread and collapsed `<Details>` mount lazily,
so an evidence-heavy document of a few MB opens and stays responsive. Two
practical bounds: keep a single `<Json>` payload to tens of KB (split a giant
blob across drill-downs), and stay under the 8 MiB transport ceiling —
`planLint` warns above 6 MB and errors above 8 MiB — by splitting a batch that
large into per-pack documents rather than thinning its evidence. A filterable
master `<Table>` keeps a large batch navigable without paying for the evidence
up front.

## 8. `<HtmlBlock>` and `<Prototype>` are bounded escape hatches

Native blocks are themed, annotatable per block and sized by the renderer; an
iframe is none of those — its height is your guess, it draws its own
background, and a comment can only anchor to the whole frame. So `<HtmlBlock>`
(static) and `<Prototype>` (interactive) are for the figure the vocabulary
genuinely lacks, authored against the sandbox theme tokens so it reads in dark
mode. A UI mockup belongs in `<Screen>`/`<DesignBoard>`, where it keeps the
surface footprint and the tokens.

## 9. Final checklist

Read the document as its reader, then check each line:

- **The first screen test.** A reader who has read nothing can state the
  conclusion and their decision from the first screen; the `after_first_screen`
  line in the frontmatter is what they would say.
- **Overview before detail**, sections numbered, drill-downs holding what the
  reader does not need on the first pass (file map, diff tabs, raw records).
- **Every claim has its example** — a quoted sentence, a shown record, a
  screen — beside it.
- **Judgement is in tone, badge, meta or callout**, and a batch is triaged by
  tone at a glance rather than as identical grey headings.
- **No label the document coined is left unglossed**, in the body or in the
  question form; no thread id, item code or "per the report" stands in for
  what it refers to.
- **All evidence needed to decide is inside the document** (§7).
- **Every decision the reader is asked for has a capture surface** — a
  `<ReviewChoice>` per item, a `<QuestionForm>` for balanced calls, span
  annotation for the rest — rather than "reply in chat with your verdicts".
  (A document that asks for no decision has none of these; that is correct.)
- **The question form reads in isolation** and every `refs[].anchor` resolves
  (renaming a heading changes its slug; the lint flags a dangling one).
- **No horizontal scrolling at desktop width**: long strings wrapped or
  wrap-toggleable (`<FieldDiff>` always wraps; `<Code>`/`<Json>`/`<Diff>` carry
  a toggle, `wrap` ships them wrapped).

## 10. Before handoff, look at the rendered document

Render the document to a standalone page and PNG slices of it, and read the
slices:

```
node apps/web/scripts/lint-plan.mjs <doc>.mdx --out <doc-dir>/render.html --png
```

`--out` keeps the markup the render-health check already produces, with the
app's stylesheet inlined and image sources resolved, so the page is what the
reader sees. Write it beside the document (`render.html` in the document's own
folder — gitignored, as are the slices): images are then relative to the page,
which is the only form that loads both when you open the file directly and
when a human opens it in-app from its file chip.

`--png` screenshots that page at the in-app reading width as page-height
slices beside it (`render-1.png`, `render-2.png`, …; the run prints each
path). Open every slice with the `read` tool, which shows you the image. A
slice is sized to stay legible at the resolution a model reads an image, and
the cut falls wherever the page height does, so a block or heading continued
across two slices is the slicing, not a defect. Do not load browser tools to
look at the page instead: the slices show the same render, and a loaded tool
stays in your context for every later turn. If the run cannot write the
slices (no chromium on this machine), the visual check is out of reach in
this thread: say so in your report. Reserve a browser or a live instance for
what genuinely needs interaction — annotation, `<Prototype>` flows, a
`<QuestionForm>`, a layout question that depends on the real panel width.

Fix overlap, excessive whitespace, clipped fragments, misleading inactive
controls, poor contrast and unreadable diagrams before handing off. The page
renders dark; the app follows the reader's theme, so a surface that reads
here and is authored with `--wf-*` tokens and semantic helper classes reads
in both — a white mockup panel or low-contrast muted text on this page is a
defect to fix in the source. One block the page cannot show: a `<Mermaid>`
appears as a `Rendering diagram…` placeholder, since it draws only in-app —
so the diagram's safety is in its shape (few nodes, short labels, per
`block-vocabulary.md`) and in the sentence under it saying how to read it,
and an author who cannot open the app before handoff says so rather than
hunting for a defect in the page. The check
also reads the rendered _text_ for defects no static pass can see — literal
`\uXXXX` escapes and latin-1 mojibake (`â€”`) written into captions and prose
by a build script or a re-encoded file. Both are errors; fix the source that
produced them.
