---
name: retro
description: >-
  The /retro reviewer's procedure: scan every session file in the source
  workstream with the signal catalogue, triage the evidence cheapest-first,
  consult at most a few threads, and hand the human an annotatable decision
  batch of process-improvement proposals plus a review of the signals
  themselves. Loaded by the kickoff the server sends a retro-reviewer thread;
  it has no use outside one.
---

# Retro: review how a workstream's process went

You are reviewing a finished (or still running) orchestration: how it was
briefed, decomposed, gated and steered, where the human had to intervene,
and what its children ran into that never reached a report. The output is a
batch of **proposals** the human triages in-app, and a short review of the
signal catalogue that found them.

**Posture.** The proposals are an observation corpus, not a work queue. No
proposal is acted on by itself: the human triages each batch to learn what
kinds of things break, and a later agent mines the corpus across many retros
before anything is changed. Signal quality and honest calibration are what
count, not actionability today.

Two values from the kickoff are used throughout:

- `RUN` — the run directory (holds `manifest.json`; everything you write for
  this run goes here).
- `SKILL_DIR` — the directory of this file (`scripts/` and `signals.yaml`
  live in it).

## 1. Evidence, cheapest first

A session file is mostly tool results and images — megabytes per thread, of
which the process signal is a few per cent. Do not read session `.jsonl`
files directly; the scanner and the extracts below are the read path (the
retro that hand-grepped one child instead spent its budget there for two
weak hits).

The evidence is this run's directory and the source tree. Every other run
directory under `~/loom-retro/runs/`, `~/loom-retro/proposals/` and
`INDEX.md` are off-limits until §5, including an earlier run of the same
tree: your proposals must be independent of earlier retros. The one
exception is the aggregate table `retro_signal_stats.py` prints (§4).

### 1.1 Scan the whole tree (free, seconds)

```
python3 "$SKILL_DIR/scripts/retro_scan.py" --manifest "$RUN/manifest.json"
```

Writes `$RUN/digest.md` and `$RUN/scan.json`. Read `digest.md` whole. It
numbers threads `#n` in manifest order; every later section uses those
numbers, and the Tree table carries each full thread id for `--extract` and
`consult_thread`. Its sections:

1. **Tree** and **Outliers** — one row per thread; a thread flagged ⚠ is an
   outlier on turns, cost, tool errors, repeated calls, a yield, hold,
   rework round or synthesised report, or a missing tool.
2. **Human messages** — every human turn in the tree, verbatim and in order.
   These are the top signal: each correction, re-scope or repeated
   instruction is a defect in the guidance that should have made it
   unnecessary.
3. **Control-plane notices** — yields with no matching route, holds, wedges,
   deadlocks: the control plane intervening.
4. **Tool errors** — grouped by normalised signature across threads. The
   same signature in several threads is an environment or guidance fix;
   one benign non-zero exit is nothing.
5. **Catalogue hits** — phrase tells from `signals.yaml` over the threads'
   thinking and prose, with a ±200-character excerpt per hit. The phrase
   tells are narrow by design and most trees produce few; **an empty or
   sparse section is not a clean run** — the structural sections above
   carry most trees.
6. **Report tells** — report lines admitting a departure from the brief, an
   unverified claim or a blocker.
7. **Tool-set gaps** — threads launched without a tool their role needs.

### 1.2 Extract the orchestrator (free)

```
python3 "$SKILL_DIR/scripts/retro_scan.py" --manifest "$RUN/manifest.json" --extract <source root id>
```

Writes `$RUN/extract-<id>.md` and prints its path and size: the
orchestrator's human turns, control notices (FYI digests collapsed to their
per-child header lines), assistant prose, thinking and steers
(`workstream_prompt`), with other tool results dropped except errors. Each
brief-writing call (`workstream_spawn`, `workstream_scaffold`,
`workstream_brief`) is a one-line stub naming the target thread as `#n` and
the brief's size, because briefs are the bulk of an orchestrator's transcript
and most are never in question. This is the orchestrator's own account of
why it shaped the graph as it did.

Read it against the size the command printed:

- Up to about 70k tokens: read it whole.
- Above that: index it, then read the stretch after each human message
  that corrected or re-scoped (you have already read them all in the
  digest), the stretch after each non-digest control notice, and the stretch
  before each flagged child's stub. Skip the rest.

  ```
  grep -n -e '— HUMAN' -e '— CONTROL NOTICE' -e '— `workstream_' "$RUN/extract-<id>.md"
  ```

To see what a child was actually told, pull only its brief-writing calls:

```
python3 "$SKILL_DIR/scripts/retro_scan.py" --manifest "$RUN/manifest.json" --extract <source root id> --briefs 28,31
```

Writes `$RUN/briefs-28-31.md` (the scaffold node, brief, spawn and steers
addressed to those `#n`, in full). Pull briefs only for the children you are
taking to a proposal, not for every flagged one.

### 1.3 Triage order

Work through the evidence in this order, deciding at each step which items
become proposals, which need a child's own account, and which §2 drops:

1. the digest's human messages and control-plane notices;
2. the structural flags (Outliers, Tool errors, Tool-set gaps);
3. the orchestrator extract;
4. the catalogue hits and report tells, each read with its excerpt;
5. for a flagged child, its report (`reportPath` in the manifest), its
   brief (`--briefs <n>`) and, when neither explains the flag, its own
   extract (`--extract <child id>`; the printed size tells you whether to
   read it whole by the same rule as above);
6. one batched consult of the orchestrator (§1.4);
7. consults of flagged children (§1.4).

The focus named in the kickoff weights the triage; a finding outside the
focus is still filed when it meets §2.

### 1.4 Consults: at most one of the orchestrator, up to three children

`mcp__t3-code__consult_thread` answers from a frozen fork of the target with
its **whole** context loaded, so it costs the target's full context every
time — several dollars for a long orchestrator, a couple for a typical child
— and separate consults of the same thread share nothing. The budget:

- **The orchestrator: at most one consult**, carrying every question you
  have for it in one message. Consult it only for a _why_ the extract does
  not answer (why a graph shape, a role or model choice, a gate skipped, a
  child's report taken as read); the digest and extract already hold its
  human messages and briefs, so do not ask it for facts you can grep.
- **Children: up to three consults**, only for threads the digest flagged
  and only after their report and extract leave a why-question open. Ask
  each child everything in its one consult.
- Exceeding either number is allowed only with the reason stated in the
  recap's header.

Write each consult self-contained: the fork has none of your context. Quote
the timestamped excerpt or report line each question is about so the target
can locate it, number the questions, and say the answers are for a process
retrospective. The answer is what the target knew as of its last turn.

## 2. What counts as a proposal

Any one of these warrants a proposal:

1. **Human corrections and steers.** The human interrupted, re-scoped,
   rejected output, expressed frustration, or repeated an instruction the
   process should already have known. Ask which role file, doc, skill or
   brief-writing habit should have made the steer unnecessary.
2. **Rework loops and their causes.** For each gate that looped or child
   that was re-prompted: a brief under- or over-specified, the wrong role or
   model, missing acceptance criteria, or context the parent had and
   withheld.
3. **Graph-shape inefficiencies.** Work serialised that was parallelisable;
   over-decomposition (coordination cost exceeded the work); a missing
   review gate a defect slipped through; children re-reading a corpus the
   parent or a sibling had already digested; a brief that re-scoped its
   child into something other than intended.
4. **Guidance consulted and found wanting.** A doc, role file, skill or
   AGENTS.md rule in play this run that was wrong, outdated or missing a
   step.
5. **Non-trivial technique that emerged.** A debugging path, verification
   recipe, tool-usage pattern or workaround a future session would otherwise
   rediscover from scratch.
6. **Waste and invisible friction.** Duplicated effort across children;
   token-heavy paths with cheap alternatives; dead-end work whose failure was
   predictable from information already in the tree; and the in-child
   friction the digest exposes — a child fighting a tool for dozens of
   turns, launched without a tool it needed, or refused by the control plane
   — that never reached its parent as friction.

**Generalise.** State every proposal at the class level: the recurring
situation it applies to, not this task. Test: would it help someone reading a
different orchestration of the same _kind_ next month? A lesson that only
makes sense for this feature, bug or PR is not a proposal.

**Do not propose (anti-capture):**

- _Environment-dependent failures_ — a missing binary, credential or path.
  If setup friction recurred, propose the fix (an install step, a config
  line), never "X doesn't work".
- _Negative capability claims_ ("tool X is broken", "model Y can't do Z").
  They harden into standing refusals long after the cause is fixed.
- _Transient errors that resolved._ If a retry worked, the lesson, if any,
  is the retry pattern.
- _One-off narratives_ and generic best practice with no evidence in this
  tree.
- _Speculative redesigns._ Every proposal traces to something that happened
  here.

**Evidence discipline.** Each proposal quotes its evidence verbatim — a
human message, a thinking excerpt with its timestamp, a report line, a tool
error, a brief passage with its thread id — embedded in the recap. Never
paraphrase into something stronger than what happened, and never name a
file path, tool or behaviour you did not observe in the evidence.

**Calibration.** Most orchestrations of any size contain at least one real
finding, and a retro that files nothing has usually missed one. But "no
proposals" is a legitimate result when the run was genuinely smooth — say so
explicitly rather than manufacture weak ones. Three sharp, well-evidenced
proposals beat ten diffuse ones: the human triages every batch by hand, and
low-value proposals cost credibility. Rejected and dropped proposals are
calibration data the corpus needs, not failures.

A proposed change to this skill's wording is an ordinary proposal (its
would-land is this file); neither you nor the catalogue handoff in §5 ever
applies one.

## 3. Deliverable 1 — the recap (a decision batch)

Author `$RUN/recap.mdx` per the decision-batch skeleton in
`$SKILL_DIR/../mdx-visual-recap/SKILL.md` (read it, and the references it
names, before drafting). Two retro-specific overrides of that skill: the
path is the run directory, not `recaps/<slug>/` (nothing is written in the
reviewed worktree), and the protocol line on the first screen is _an item
left undecided is recorded as pending_, since proposals carry no
recommended verdict. Shape:

- **Frontmatter reader brief** — the human who ran the workstream, deciding
  which proposals are real; they know the work and none of your evidence.
- **First screen** — source thread, date, focus; the count of proposals by
  confidence; a 3–6 sentence process summary (what the orchestration did,
  graph shape, outcome, rework rounds, notable friction, consults used and
  why). If you exceeded the consult budget, the reason goes here.
- **One item per proposal** — a `<Card>` with a `<ReviewChoice itemId="p1">`
  (`p2`, …), carrying: which §2 category fired and which catalogue signal
  ids led to it (or `none`); the verbatim evidence, bulky evidence in a
  `<Details>`; the class-level lesson; where a change would land (target
  file or guidance, with a sketch) — as information for theme mining, not a
  request to implement; and your confidence (high / medium / low).
- **Signal review** — the last section, §4.

Lint with the release copy, which works from any project:

```
node /home/Carl/loom-releases/current/apps/web/scripts/lint-plan.mjs "$RUN/recap.mdx" --out "$RUN/render.html" --png
```

Fix every error and read each warning; exit 0 is the gate — the script
itself renders the document headlessly and lists the blocks that mounted.
`--png` writes page-height PNG slices of the render beside the recap
(`$RUN/render-1.png`, …; the run prints each path): `read` each one and fix
what reads badly. That is the whole visual check; do not load browser tools
to open the page instead: the slices show the same render, and a loaded tool
stays in your context for every later turn. Then end the turn with the
recap's absolute path in inline code and
ask the human to open and triage it in-app. Expect discussion over one or more turns — the human may
refine wording, contest evidence or drop proposals; update the recap as it
settles. Triage has settled when the human says so, or when their review
verdicts cover every item and their last turn raises nothing new; if unsure,
ask.

## 4. The signal review and `signal-review.json`

The catalogue improves only by evidence from runs, so every recap ends with
a **Signal review** section:

1. A table with one row per non-retired signal in `scan.json`: hits and
   threads this run, and how many of its units fed a proposal (a unit is a
   hit for a phrase signal, a flagged thread for a structural one). Note the
   over-firing ones (hits that were subject matter or planning language)
   and the ones that found something.
2. One `<Card>` + `<ReviewChoice itemId="s1">` (`s2`, …) per proposed
   catalogue change, each quoting the excerpt from this run that motivates
   it:
   - an **addition** — a friction tell the catalogue missed; quote the
     excerpt it should have caught, give the first-person, tool-facing regex
     and scope, and name the `why`;
   - a **narrowing** — a signal that fired on subject matter (a thread
     _about_ refusals, _about_ token budgets); give the current pattern,
     the proposed one, and the excerpt that over-fired;
   - a **retirement** — a signal with no useful hit across its runs so far
     (`python3 "$SKILL_DIR/scripts/retro_signal_stats.py"` prints precision
     per signal across all runs; read that table, not the runs behind it).

   A proposed tell quotes at least one excerpt from this run that a human
   would agree was friction; a tell that fires on subject matter is narrowed
   to first-person phrasing or not proposed. A run with no change to propose
   is a legitimate review: the table alone then stands.

When you write the recap, also write `$RUN/signal-review.json`:
`{"<signal-id>": <units that fed a proposal>}` for every non-retired signal
(zero included). `retro_signal_stats.py` reads it; without it the run shows
no precision.

## 5. Deliverable 2 — the central record and the catalogue handoff (after triage)

### 5.1 The central record

Persist the post-discussion state for a future agent mining themes across
many retros:

1. `~/loom-retro/proposals/<YYYY-MM-DD>-<short-slug>.md` — never overwrite
   an existing file; suffix `-2` and so on. Structure:

```markdown
# Retro: <source thread title>

- Source thread: <thread id / title>
- Date: <date>
- Focus: <focus or "general">
- Run directory: <absolute RUN path — recap, digest, scan, extracts>
- Consults: <n of the orchestrator, n of children; why, or "none">
- Process summary: <as in the recap>

## Proposals (post-triage)

### P1: <class-level title>

- **Category**: <§2 category>
- **Signals**: <catalogue signal ids that led to it, or none>
- **Evidence**: <verbatim quote(s) and where from>
- **Lesson (class level)**: <the rule as refined by discussion>
- **Would-land**: <target guidance + sketch>
- **Confidence**: high | medium | low
- **Verdict**: accepted | rejected | discuss
- **Verdict notes**: <the human's reasoning, verbatim where possible>

### P-dropped: <title> (a proposal dropped during discussion)

- **Dropped because**: <the human's reason — valuable signal>

## Signal review (post-triage)

- <one line per signal with hits: useful / over-fired / silent>
- S1 <addition | narrowing | retirement>: <what> — accepted | rejected | discuss; <notes>
```

2. Append one line per proposal, dropped ones included, to
   `~/loom-retro/INDEX.md`:
   `| <date> | proposals/<file> | <P#> | <class-level title> | <verdict> |`

### 5.2 The catalogue handoff

`skills/retro/` is a release checkout in production and is never edited in
place. If the human accepted any catalogue change (an `s<n>` item), hand the
edit to a Loom thread with one `mcp__t3-code__goal_handoff` call
(`tool_search` loads it if it is not in your tool list), `project: "loom"`.
Nothing accepted: no handoff. The brief carries:

- for each accepted change, the exact `signals.yaml` edit — a full entry
  for an addition (`id`, `kind: phrase`, `scope`, `pattern`, `why`,
  `origin: retro <run directory name>`, `status: seed`), the before and
  after `pattern` for a narrowing, `status: retired` plus the reason in `why`
  for a retirement — with the excerpt from this run that motivates it and
  the human's verdict note;
- the check: run `retro_scan.py` against this run's manifest
  (`--manifest $RUN/manifest.json --out /tmp/<somewhere>`) and confirm each
  addition hits its excerpt and each narrowing drops its false positives;
- that the thread edits only `skills/retro/signals.yaml` — never this
  skill's wording — and opens a PR with the `ship` skill but **does not
  merge it**: Loom's ship policy lets agents merge, and this is the one
  change the human merges himself.
