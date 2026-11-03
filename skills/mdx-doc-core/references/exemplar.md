# Skeletons and anti-patterns

Read this alongside `document-quality.md`. Each skeleton below is the order a
good document of that genre reads in, top to bottom, with what the first
screen holds spelled out, because the first screen is where these documents
have most often gone wrong. The skeletons' subjects are invented; the shipped
exemplars are real documents.

> **Two exemplars are shipped: the recap, and the decision card.** Their
> sections below point at the documents. The intent-brief, plan and explainer
> sections name candidate documents written under these skeletons but not yet
> approved as canonical. Read them for the register, and take the skeleton as
> the bar where they differ. Once an exemplar is approved, read it before the
> skeleton, and where they conflict the exemplar wins.

## An intent brief

The brief the bulk-archive plan below is written under. One screen, read by
the owner in about a minute, every line checkable or quoted. It is shown whole
because its shape is the point:

```mdx
---
reader:
  who: the owner, who asked for this and approves its intent before anything is built
  knows: their own request; nothing of the codebase or the plan
  after_first_screen: they can correct any line or say "go"
kicker: "Intent brief · draft for your corrections · 3 Mar 2026"
status: draft
# plan: plans/<slug>/plan.mdx once a plan exists
---

# Archive a batch of contacts in one go, without losing one by mistake

**Goal.** "I keep archiving stale contacts one at a time and it takes all
morning." Archive many contacts in one action from the list, as safely as
archiving one.

**You'll know it works when.**

- You tick a handful of contacts in the list, choose Archive, and they leave
  the list at once.
- You change your mind straight after and one click brings them all back.
- **Must not:** archive a contact you did not tick; slow the list on a page
  of a thousand contacts.

**Approaches in play.**

- Archive at once with an undo toast. Wins if undo is trusted enough that no
  confirm dialog is needed. _Your pick._
- A confirm dialog listing the contacts. Wins if a mis-archive is costly
  enough to pay a click every time.
- Dropped: a separate bulk-actions page. It moves the work away from the
  list, where it starts.

**Decided.** "no new page for this, it lives in the list". Web only for the
first cut.
_Assumed:_ archived contacts stay searchable, as they do today; redirect if
wrong.

**Not doing.** Bulk delete. Mobile.

**Questions for you.**

<QuestionForm
  questions={[
    {
      id: "undo-window",
      title: "How long does undo stay available?",
      subtitle: "Decides whether archiving is immediate or waits for the toast to close.",
      mode: "single",
      options: [
        { id: "toast", label: "Until the toast closes, then it is final", recommended: true },
        { id: "session", label: "For the rest of the session" },
      ],
    },
  ]}
/>

**Still unknown.**

- Does archiving a thousand ticked contacts at once stay quick enough that
  the list never freezes? A spike against the largest seeded list settles it.
```

The parts, who may change each line, and the `status` lifecycle are in
`mdx-visual-plan/SKILL.md`.

Candidate, not yet approved: `plans/intent-first-workflow/intent.mdx`, the
brief for this workflow itself, as its owner corrected it, with his answers
folded into Decided.

## A plan (UI work)

A plan for adding a bulk-archive action to a contacts list, under the brief
above:

1. **First screen: the recommendation and what the user gets.** One
   paragraph.

   _Add a selection column and an "Archive selected" action to the existing
   toolbar; optimistic archive with an undo toast; about a day, web only; the
   one bet is optimistic-with-undo over a confirm dialog._

   Under it, the change as a comparable pair: a `<Columns>` with
   `<Column label="Before">` and `<Column label="After">`, each holding a
   `<Screen>` of the list header. Every other control is preserved, so the
   delta is the only thing that differs. The column labels name the states;
   the frames carry no `Before`/`After` pill of their own. Frontmatter:
   `status: draft` and `intent:` naming the brief; the fields and their
   lifecycle are in `mdx-visual-plan/SKILL.md`, 'The plan's life'.

2. **What it means.** Two or three lines: what is in the first cut, what is
   deferred, and the one line pointing at the open question at the end.
3. **`## 1. The approach`.** A `<Callout tone="decision">` stating the chosen
   approach and why, with a `<Columns>` weighing it against the alternative
   you rejected, each side one short paragraph.
4. **`## 2. The changes`.** An `<AnnotatedCode>` of the one load-bearing file
   (the list component) with two or three margin notes on the lines that
   change. A `<Details summary="All touched files">` holds the `<FileTree>`
   with change badges.
5. **`## 3. Verification`.** Prose naming the end-to-end smoke: select two
   rows, archive, confirm they leave the list and the undo toast restores
   them.
6. **One `<QuestionForm>`** at the bottom for the single genuinely open
   decision, with a `recommended` default.

Nothing repeats: the `<Screen>` pair shows the UI, the prose and code carry
the depth the pictures cannot.

Candidate, not yet approved: `plans/agent-started-thread-cue-v2/plan.mdx`,
six options on one inbox, each a toned, badged card, and a bottom form for
the one choice.

## A plan (backend / architecture work)

No visual surface. The first screen is the recommendation and the bets it
settles: _one export queue instead of two; consumers subscribe by name rather
than by registration order; the wire format and ids unchanged; about two
days_. A short objective-and-scope paragraph follows. Frontmatter:
`status: draft` and `intent:` naming the brief, as above. Then one numbered
section per change. Each holds a `<DataModel>` or `<Endpoint>` beside the
prose that needs it, an `<AnnotatedCode>` of the load-bearing file, and terse
problem / solution / why prose with the codebase's names glossed on first
use. A `<Mermaid>` appears only where a real two-dimensional relationship
(layering, data flow) clarifies something. The file map sits in a
`<Details>`. It closes with a verification section and a bottom
`<QuestionForm>` only if the next direction is genuinely open.

Candidate, not yet approved: `plans/sqlite-read-lane-v2/plan.mdx`, the
change, its cost and the headline number in the first four lines, and the
rejected alternatives as badged cards.

## A decision batch (recap genre)

A sign-off over N items: a taxonomy review, an audit, a PR-style review.

1. **First screen: the verdict with its numbers.**

   _"Of 42 proposed changes: 30 apply as written, 9 apply once amended, 3
   should be withdrawn."_

   Then one line on what that means (_the 9 amendments are all one pattern:
   the condition was written as a rule where it is a hint_). Then **one line
   of protocol**: an item left undecided takes its recommendation.

2. **`## 1. All items`.** A compact `<Table filterable>`, one row per item
   (subject, verdict class, recommendation), so the batch is scannable before
   the detail.
3. **`## 2. The items`.** One `<Card>` per item: `tone` = verdict class,
   `badge` naming the recommended answer, `eyebrow` the item's label and
   subject, `meta` chips for scope / confidence / what changes. Inside, the
   card answers the reader's questions in the order they ask them. The
   question is the heading and the answer with its reason the first line.
   Then the facts as a `<Table>` with a source column, the rule quoted, the
   readings as a `<Table>`, the change if accepted, and the cost of leaving
   it undecided. Last, a `<Details>` of evidence and a `<ReviewChoice itemId>`
   unique in the document. The parts with their reasons are in
   `mdx-visual-recap/SKILL.md`.
4. **A bottom `<QuestionForm>`** for the genuinely balanced calls only
   (rollout strategy, a schema name), not a second copy of the per-item
   decisions.

**The shipped decision-card exemplar** is Decision B in
`recaps/decision-item-anatomy/recap.mdx` §2: every part above on a real audit
cell, with the original card it replaced in a drill-down beneath it so the
two can be read side by side. The renderer test fixture at
`plans/mdx-review-blocks/plan.mdx` shows every review block in situ; it is a
fixture, not a model of the writing.

## A recap (recap genre)

A recap of a finished change: a branch, a thread's work, an incident.

1. **First screen: what the reader can now do, or what changed for them, with
   the number that proves it.**

   _"Duplicate reminders are gone from the daily digest: repeats down from
   about one in five to none on the seeded week; one endpoint removed, none
   added."_

   Then what it means: what to check, what is still open, whether anything
   needs their decision.

2. **`## 1. Before and after`.** A `<Columns>` or `<Screen>` pair when the
   change touched rendered UI. Otherwise the behaviour before and after in
   prose with one literal example each (the request that used to return X
   and now returns Y).
3. **`## 2. How it works now`.** The mechanism in the reader's terms, one
   example beside each piece, and a `<DataModel>` / `<Endpoint>` beside the
   prose for any contract that changed.
4. **`## 3. The changes`.** The key changes as one horizontal `<TabsBlock>` of
   `<Diff>` / `<AnnotatedCode>`, three to eight tabs, about 150 lines per
   excerpt, each with a one-line summary and a few line notes. A
   `<ReviewChoice>` per tab when the recap doubles as a gate. The `<FileTree>`
   change map in a `<Details>`.
5. **`## 4. Still open`.** Risks, follow-ups, and the one-line pointer to a
   bottom `<QuestionForm>` if a direction is genuinely open.

**The shipped exemplar** is `recaps/issue-280-fan-in-deadlock-v2/recap.mdx`.
It is an incident recap, so it takes the diagnosis shape rather than the
before/after sections above. `## 1` is the moments as a `<Steps>` rail, `## 2`
why, `## 3` the fix, `## 4` what is still in place today with the two
decisions as `<ReviewChoice>`, `## 5` the evidence in `<Details>`. Its first
screen, trimmed, is the register to match. The answer is in the lede with the
numbers in bold, a `<Stats>` strip holds the numbers the verdict rests on,
and the consequence is the focus callout with the recurring states as badges:

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

A document whose job is to make the reader understand something (a system, a
change, a diagnosis) rather than to approve or decide:

1. **First screen: the summary.** What the thing is, in the reader's terms,
   and the one sentence they could use to explain it to someone else. For a
   diagnosis, the cause and the one number or example that pins it.

   _"The nightly job double-counts because two rows share a key the merge
   step assumed unique; 14 of 212 buildings are affected, and each shows the
   same signature."_

2. **`## 1. The mental model`.** The two to four things the reader will meet
   and how they relate. By default these are the cases they experience
   (outcomes, states, paths, each with what triggers it and what they see)
   rather than the modules behind them. A `<Columns>` of `<Card>`s, one per
   case and toned by what it means for the reader. Or a `<Mermaid>` of at
   most about ten nodes when the relation is the point, with a sentence under
   it saying how to read it.
3. **`## 2. How it works`.** One section per piece. Each gives the mechanism
   as _input → what happens → output_ and one literal example: a real input
   and what came out, a record before and after, a quoted line. A piece with
   several facts from more than one party is the fact-dense unit below.
4. **`## 3. What this means for you`.** What to do next, what to watch, what
   is unaffected; a `<Callout tone="warning">` for the one thing that is
   urgent.
5. **`## 4. Open edges`** (optional). What the explanation does not cover or
   what the evidence does not yet settle.

No review protocol. A `<QuestionForm>` or `<ReviewChoice>` appears only where
a decision genuinely rides on the explanation.

Candidates, not yet approved:

- `explainers/mdx-document-pipeline/explainer.mdx`: one real snippet followed
  through every stage, each artefact quoted from a real run.
- `explainers/workstream-outcome-routing/explainer.mdx`: the mechanism with
  the exact messages the reader will receive, and an `<AnnotatedCode>` of the
  deciding function.
- `explainers/document-classification-v2/explainer.mdx`: a port of an HTML
  explainer, useful for its in-place vocabulary-gap notes.
- `explainers/tenant-audit-absence-model/explainer.mdx`: for non-engineers
  choosing between two directions in a meeting. Real production screenshots
  beside `<Screen>` mock-ups on the same tenant, three options as toned
  cards, one bottom `<QuestionForm>`. Anonymised.
- `explainers/fact-dense-explanation/explainer.mdx`: the research behind the
  fact-dense unit below; its first screen is that shape on a real paragraph.

## A fact-dense unit

The shape `document-quality.md` §3 names for a unit that carries several
facts from more than one party. The subject is invented; the shape is the
point.

```mdx
<Card eyebrow="2.3 · One ticket, filed wrong" heading="A refund request filed as a complaint" tone="warning">

**Verdict: marked wrong.** <Badge tone="warning">half the classifier's</Badge> <Badge tone="warning">half the guide's</Badge>

The classifier filed the ticket as a complaint. The reviewer filed it as a refund request.

The reviewer's label is the answer the run is scored against. The classifier is sent two texts: the ticket, and the label guide, which says what each class means and which fields it needs.

<Table
  density="compact"
  columns={["Who", "What they say about the ticket", "Where"]}
  rows={[
    [
      "**The ticket**",
      '"I\'d like my money back for the kettle. It stopped heating after a week."',
      "Ticket 4127, first line",
    ],
    [
      "**The label guide**",
      "A refund request names the order it is about. A message with no order number and a grievance is a complaint.",
      "Label guide §2",
    ],
    ["**The reviewer**", "Refund request. Order field: `not given`.", "Review sheet, row 118"],
    {
      tone: "risk",
      cells: [
        "**The classifier**",
        { badge: { label: "wrong", tone: "risk" }, md: "Complaint. Order field empty." },
        "Run 14 output",
      ],
    },
  ]}
/>

**Why it is marked wrong.** A label passes only when its class matches the reviewer's. The reviewer wrote refund request and the classifier wrote complaint. <Sidenote>Scoring rule: class match first, then fields.</Sidenote>

**If the classifier had chosen refund.** It would still have failed, this time on the order field. The reviewer's value is the phrase `not given`, which the scorer compares letter for letter. Nothing the classifier was shown contains that phrase. <Sidenote>Review sheet, row 118, order column.</Sidenote>

**Whose miss.** Half the classifier's: the ticket asks for money back in its first line. Half the guide's: nothing the classifier was sent says what to write when the order number is missing. <Sidenote>Label guide §2, "Refund requests".</Sidenote>

**The ticket next door.** The same customer wrote again the next day with the order number. Both the reviewer and the classifier filed that one as a refund request, and it scored correct. <Sidenote>Ticket 4131, review sheet row 119.</Sidenote>

</Card>
```

It reads because the verdict comes before the facts, so the reader knows what
the table is for. The table holds the four readings, so the reader does not.
Each judgement has a label to find it by, and its source sits beside the
sentence rather than inside it.

## Anti-patterns, and what each costs the reader

Communication:

- **Protocol first.** The first viewport spent on how to review ("silence
  means accept…") before the reader knows what is being decided. They scroll
  to find the answer, or stop.
- **The work objective as the opening.** _"The server has two connection
  pools, an in-process writer and a worker-thread reader…"_ is the writer's
  starting point, in the codebase's vocabulary. The recommendation is two
  screens down; the reader reaches it tired.
- **Insider register.** Thread ids, item codes ("M4", "D2 of the earlier
  plan"), "per the report", a section title used as a noun. The reader was
  not there; each one is a word they cannot resolve.
- **A claim with no example.** "The classifier over-triggers on amendments."
  Which amendment, saying what, classified as what? Without the instance the
  claim is a label.
- **Judgement written out where a badge exists.** Three sentences per option
  on strength, collision and cost, where `badge="RECOMMENDED"` and
  `meta={["client only", "no new RPC"]}` would carry it.
- **A plan written as a changelog.** "Unlike the previous version…", "as
  discussed above…". The reader has no previous version.
- **A jargon-gated question.** A bottom `<QuestionForm>` leaning on labels
  the document coined ("Yes, fold it into slice 1"), so a reader who skimmed
  the body cannot answer. Gloss in `subtitle` and name the outcome in the
  label: "Yes, build the meter in the same pass as the settings page". A
  `refs` chip lets them read the section; it does not carry the meaning the
  label left out.
- **A questions wall mid-document.** A second list of open questions, or a
  "decisions" section, above the bottom form. The reader meets the same
  question twice and does not know which to answer.
- **A marketing hero.** A landing-page heading, value props, a "why this
  matters" card on a document whose first paragraph already says why.

Renderer mechanics, which are facts about what the renderer does, not taste:

- **Hard-coded hex instead of tokens.** A wireframe `html` with
  `style="background:#fff;color:#111"` or a `font-family` breaks in dark
  mode; use `var(--wf-paper)` / `var(--wf-ink)` and leave the font alone.
- **A desktop and a mobile frame for a change that is a popover or a panel.**
  Pick the one surface the user actually sees.
- **A mockup in `<HtmlBlock>`.** It loses the surface footprint, the theme and
  the tokens that `<Screen>`/`<Design>` give it.
- **Before/After baked into the frame.** A pill, title or heading inside the
  wireframe `html` naming the state. The `<Column label>` (or `<Artboard
  caption>`) is where the state name belongs.
- **Overlapping artboards.** `browser` frames touch or overlap at any x-gap
  under 1800 board units and have no clear gutter under 2200, because a frame
  consumes about twice its pixel width in board units. Use the gaps in
  `canvas.md` (≥ 2200 between browser frames; ≥ 1000 between compact
  `mobile`/`popover`/`panel` frames).
- **A product screen polluted with plan notes.** Repo pills, file-contract
  arrows or architecture notes drawn inside the screen. Keep the screen pure
  and put those in a `<DesignBoard>` `<Annotation>`, a `<Diagram>` or the
  prose.
