# Skeletons and anti-patterns

Read this alongside `document-quality.md`. Each skeleton below is the order a
good document of that genre reads in, top to bottom, with what the first screen
holds spelled out — because the first screen is where these documents have most
often gone wrong. The skeletons' subjects are invented; the shipped exemplar
is a real document.

> **Two exemplars are shipped: the recap, and the decision card** (their
> sections below point at the documents). The plan and explainer sections
> name candidate documents that are written under these skeletons but not
> yet approved as canonical —
> read them for the register, and take the skeleton as the bar where they
> differ. Once an exemplar is approved, read it before the skeleton and treat
> a conflict between them as the exemplar winning.

## A plan (UI work)

A plan for adding a bulk-archive action to a contacts list:

1. **First screen — the recommendation and what the user gets.** One
   paragraph: _add a selection column and an "Archive selected" action to the
   existing toolbar; optimistic archive with an undo toast; about a day, web
   only; the one bet is optimistic-with-undo over a confirm dialog._ Under it
   (or under the "what it means" lines, when the pair is tall enough to push
   them off the first screen), the change as a comparable pair — a `<Columns>` with
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

Candidate, not yet approved: `plans/agent-started-thread-cue-v2/plan.mdx` (six
options on one inbox, each a toned, badged card; a bottom form for the one
choice).

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

Candidate, not yet approved: `plans/sqlite-read-lane-v2/plan.mdx` (the change,
its cost and the headline number in the first four lines; rejected
alternatives as badged cards).

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
   `badge` naming the recommended answer, `eyebrow` the item's label and
   subject, `meta` chips for scope / confidence / what changes. Inside, the
   card answers the reader's questions in the order they ask them: the
   question as the heading; the answer with its reason in the first line; the
   facts of the case as a compact `<Table>` with a source column, an unknown
   stated as unknown; the rule at stake, quoted; the readings as a `<Table>`
   whose column labels name the party, basis and date (a `<FieldDiff>` where
   there is a genuine before/after); the change if accepted and the file it
   goes into; the cost of leaving it undecided, in one line; then a
   `<Details>` holding the bulk evidence and a `<ReviewChoice itemId>` with an
   id unique in the document — a duplicate id silently collapses two widgets
   onto one decision. A simpler item takes fewer parts in the same order. The
   parts with their reasons are in `mdx-visual-recap/SKILL.md`.
4. **A bottom `<QuestionForm>`** for the genuinely balanced calls only
   (rollout strategy, a schema name) — not a second copy of the per-item
   decisions.

**The shipped decision-card exemplar** is Decision B in
`recaps/decision-item-anatomy/recap.mdx` §2 — every part above on a real
audit cell, with the original card it replaced in a drill-down beneath it so
the two can be read side by side. The renderer test fixture at
`plans/mdx-review-blocks/plan.mdx` shows every review block in situ; it is a
fixture, not a model of the writing.

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

**The shipped exemplar** is `recaps/issue-280-fan-in-deadlock-v2/recap.mdx`:
an incident recap, so it takes the diagnosis shape (`## 1` the moments as a
`<Steps>` rail, `## 2` why, `## 3` the fix, `## 4` what is still in place
today with the two decisions as `<ReviewChoice>`, `## 5` the evidence in
`<Details>`) rather than the before/after sections above. Its first screen,
trimmed, is the register to match — the answer in the lede with the numbers
in bold, a `<Stats>` strip of the numbers the verdict rests on, and the
consequence as the focus callout with the recurring states as badges:

```mdx
# The workstream that deadlocked on an edge nobody drew

A five-thread workstream sat stuck for **43 minutes** after one child finished,
and nobody was told. … The cause was **one dependency edge the graph had but
never wrote down**: … A cycle of four edges, of which the cycle checker could
see three.

<Stats
  items={[
    {
      value: "43 min",
      label: "Silent deadlock",
      tone: "risk",
      detail: "Child done 12:36; nothing moved until the orchestrator intervened by hand at 13:16",
    },
    {
      value: "4 fixes",
      label: "Shipped next day",
      tone: "success",
      detail: "Today: 1 in place · 2 moot · 1 lost",
      badge: { label: "1 lost", tone: "risk" },
    },
  ]}
/>

<Callout tone="decision" title="What it means now" focus>
  The fix (PR #288, merged the next day) drew the missing edge … **Ten days
  later, pull 9 moved loom to shared checkouts** … so there is no merge step
  and the invisible edge no longer exists. That leaves **one thing to act on**
  … Both are decisions at the end of §4; an item left undecided takes its
  recommendation.

  <Badge tone="success">deadlock notice · in place</Badge> <Badge tone="neutral">missing-edge guard · moot</Badge> <Badge tone="risk">stale-flag clear · lost</Badge>
</Callout>
```

Read the whole document before writing a recap: the audit of what is still in
place today (`## 4`) is the part its reader valued most.

## An explainer (explainer genre)

A document whose job is to make the reader understand something — a system,
a change, a diagnosis — rather than to approve or decide:

1. **First screen — the summary.** What the thing is, in the reader's terms,
   and the one sentence they could use to explain it to someone else. For a
   diagnosis, the cause and the one number or example that pins it: _"The
   nightly job double-counts because two rows share a key the merge step
   assumed unique; 14 of 212 buildings are affected, and each shows the same
   signature."_
2. **`## 1. The mental model`** — the two to four things the reader will meet
   and how they relate, by default the cases they experience (outcomes,
   states, paths — each with what triggers it and what they see) rather than
   the modules behind them: a `<Columns>` of `<Card>`s one per case, toned by
   what it means for the reader, or a `<Mermaid>` of at most about ten nodes
   when the relation is the point, with a sentence under it saying how to read
   it.
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

Candidates, not yet approved: `explainers/mdx-document-pipeline/explainer.mdx`
(one real snippet followed through every stage, each artefact quoted from a
real run), `explainers/workstream-outcome-routing/explainer.mdx` (the
mechanism with the exact messages the reader will receive, and an
`<AnnotatedCode>` of the deciding function) and
`explainers/document-classification-v2/explainer.mdx` (a port of an HTML
explainer, useful for its in-place vocabulary-gap notes) and
`explainers/tenant-audit-absence-model/explainer.mdx` (an explainer for
non-engineers who must choose between two directions in a meeting: the answer
with its numbers in the lede, real production screenshots beside
`<Screen>` mock-ups on the same tenant so the two are visibly different kinds
of picture, a `<Steps>` walk-through, three options as toned cards, and one
bottom `<QuestionForm>` for the calls the room must make; anonymised, so the
tenants and the client are fictional).

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
