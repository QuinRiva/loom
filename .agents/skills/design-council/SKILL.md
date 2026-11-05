---
name: design-council
description: >-
  Run Loom's design council: two Claude scorers rate screenshots of the web
  app on a seven-category rubric, a coder fixes the Loom surfaces between
  rounds, three rounds at most, and the PR carries the rounds table. Use when
  Carl or an orchestrator says "design council" or "run the design council".
  Not for reviewing code, a PR or a plan, and not a general second opinion
  from another model; those are ordinary reviewer threads.
---

# Design council

Adapted from Theo's `council` skill: models score the app out of 10, a coder
fixes, the models score again. Here the scorers are two Claude models, the
rubric has seven categories each scored twice (upstream elements and Loom
elements), scoring is absolute and every scorer starts cold, and the loop stops
at three rounds. The thread that loads this skill orchestrates the loop and
never scores anything itself.

## Where everything goes

`.artifacts/loom-ui-council/round-<n>/` holds that round's 28 images, named
`<screen>-<dark|light>.png`, its `manifest.md`, and the orchestrator's
`summary.md`. The manifest has one `## <screen>` section per screen with
`source:`, `dark:` and `light:` (worktree-relative paths), `Loom elements:` and
`Upstream elements:` lines copied from the screen table below, in the table's
order. A calibration round adds a `## Calibration` section with one `image:`
and `url:` pair per screenshot. Scorers read nothing but the manifest and the
files it names, so the manifest carries everything they need.

## The rubric

Seven categories, each scored 0 to 10 twice per set of screenshots: once for
the upstream elements and once for the Loom elements, as the manifest labels
them.

| Category               | What a 10 means here                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Typography             | One scale, sizes and weights that signal hierarchy, nothing under 11px that must be read, no stray families or casing                     |
| Hierarchy              | The eye lands on the most important thing first on every screen; secondary and tertiary information recede in that order                  |
| Spacing and density    | Even rhythm, aligned edges, dense where the user scans and airy where they read; nothing cramped or stranded                              |
| Colour and contrast    | Colour appears only where it carries meaning and the same meaning everywhere; every text meets 4.5:1; dark and light are equally resolved |
| Iconography            | One icon family at one stroke, sized to its text, each icon meaning one thing                                                             |
| Consistency and polish | The same element looks the same everywhere; radii, borders and hover states from one system; no leftovers from an older design            |
| Clarity                | A first-time viewer can say what each element is and what state it is in without a tooltip                                                |

Scoring is absolute against those lines, never relative to a previous round. A
scorer is spawned fresh each round and told nothing of earlier scores, which is
what stops the drift Theo saw when an app was scored against its previous self.

## The screens

Fixed and named, captured in dark and light every round at a 1440 × 900
viewport. Twelve come from the seeded dev instance of the dev-verify recipe
(`docs/dev-site-testing.md`): its seed carries one control card per notice
kind, a synthesised yield, consults, a staged root and a stored
`needs_guidance`. Two come from the `/preview` harness
(`docs/web-component-preview.md`), because the seed has no hub data or pi
session.

| Screen                         | Source                                                   | Loom elements scored                                                                     | Upstream elements scored                       |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `sidebar-home`                 | Dev instance, first project                              | Rollup badges, cache fuel rings, agent-started rail                                      | Thread rows, PR badge, section headers, search |
| `orchestrator-thread`          | Dev instance, the seed root                              | Control cards (digest, every notice), kickoff bubble                                     | Composer, timeline chrome, title bar           |
| `orchestrator-thread-expanded` | Same, digest expanded                                    | Items, excerpts, document chips, raw payload toggle                                      | Markdown prose inside the excerpt              |
| `child-thread`                 | Dev instance, the done coder                             | Kickoff bubble, consult card (answered), handoff receipt, lineage breadcrumb, tabs strip | Assistant turn, tool rows                      |
| `workstream-panel`             | Right panel on the root                                  | Active strip, model text, graph at fit-to-view, legend                                   | Panel tabs, panel title row                    |
| `workstream-timeline-drawer`   | Graph node middle-click                                  | Timeline drawer, quick facts on hover                                                    | Panel frame                                    |
| `goal-panel`                   | Goal panel on the root                                   | Task tree, Threads section, task thread chips                                            | Panel frame                                    |
| `plan-document`                | An `.mdx` plan opened in the file panel                  | Cards, stats, callout, table, inline code, code block, badges                            | File panel chrome                              |
| `plan-document-review`         | Same, scrolled to the question form                      | Question form, annotation pins, sidenote                                                 | File panel chrome                              |
| `staged-root`                  | The held root                                            | Staged kickoff card, brief preview                                                       | Composer                                       |
| `settings-general`             | Settings › General                                       | Loom rows (auto-open, context-viz)                                                       | Every other row; the settings layout           |
| `command-palette`              | ⌘K on any thread                                         | None (a calibration screen)                                                              | The palette                                    |
| `context-viz`                  | `/preview`, "Context diagnostics" group                  | Composition, growth, timeline figures                                                    | None                                           |
| `subscription-meter`           | `/preview`, "Subscription meter" group, "Danger" fixture | The meter and its chip                                                                   | None                                           |

`command-palette` carries no Loom element on purpose: it anchors what a 10
looks like in this app. The seed workspace holds only a README, so the capture
thread copies an `.mdx` plan that has a `QuestionForm` (any approved plan under
`plans/` serves) into the seed workspace before opening it for the two plan
screens. The app follows the system colour scheme until
`localStorage["t3code:theme"]` is set, so `preview_set_appearance` switches the
theme on both the dev instance and `/preview`.

## A round

Four threads take part: a capture thread and a coder that persist across
rounds, and two scorers spawned fresh each round.

**Capture.** One thread, spawned once with
`modelSelection: { instanceId: "pi", model: "cliproxy/claude-sonnet-5-5", options: [{ id: "thinking", value: "medium" }] }`
(it reads images and drives a browser; it judges nothing), reopened and
prompted "capture round 2" and so on. It keeps the seeded dev instance up
between rounds (if the instance has died, it restarts it on the same
port-scoped home without reseeding) and stops it at the end by the PID it
recorded. Each round it takes the 28 images, writes the manifest, and then runs
the cheap gate Theo puts before the expensive models: every file exists and is
not blank, the theme matches the name, and each Loom element the manifest
names is visible. A failed check is fixed before a scorer is spawned.

**Score.** Two threads in parallel, `role: "researcher"` (its prompt carries
no code-review posture that would fight the brief; `reviewer` does), with
explicit selections and no `taskShape` (an explicit selection makes the server
ignore it):

- `{ instanceId: "pi", model: "cliproxy/claude-fable-5-1", options: [{ id: "thinking", value: "high" }] }`
- `{ instanceId: "pi", model: "cliproxy/claude-opus-5-5", options: [{ id: "thinking", value: "high" }] }`

Each gets `scorer-brief.md` from this directory pasted as its whole brief,
with `<manifest path>` replaced by the round's manifest path, and nothing
else: not the other scorer's name, not an earlier round, not this skill or
the plan the run serves.

**Aggregate and decide.** Write `round-<n>/summary.md`: both score tables,
the within-a-point check below, and after round one the lockstep check. Read
each report positionally, as the "Your report" section of `scorer-brief.md`
defines it; a `no score` cell stays `no score`, never filled in (Theo's rule).
Triage every finding into one of three lists:

- Build: a Loom surface, and the change is allowed by the brief the run serves.
- Defer to Carl: an upstream surface, a change to what a surface shows or
  where it lives, mobile, or an animation.
- Reject: contradicts a line of the brief's Decided paragraph, which the
  summary quotes.

Then apply the stop rule.

**Fix.** One `role: "coder"` thread, spawned in round one and prompted each
round with the build list, so it keeps what it changed. It commits per round
with the round number in the message, runs `vp run check:changed`, and
reports what it built, what it could not, and why. It names in its report any
file it touched outside the set the preceding restyle owned (for the first
run, the ownership table in `plans/loom-ui-alignment/plan.mdx` §7).

## Within a point of upstream

Per scorer, per category: the Loom score is at least the upstream score minus
one. The check passes in a round when all fourteen cells (two scorers × seven
categories) hold; a `no score` cell does not hold. The summary names the cells
that fail ("Opus 5.5, Colour and contrast: upstream 9, Loom 7"), and the
coder's build list for the next round leads with the must-fix findings behind
those cells.

## The lockstep check

After round one, the two scorers move in lockstep when their Loom columns
differ by less than one in every category and at least four of five of their
must-fix findings name the same screen and element. Then round two adds
`round-2/calibration/`: two public product screenshots of the Codex desktop
app. The capture thread fetches them from OpenAI's product pages and records
the URLs in the manifest's `## Calibration` section, which is what makes each
scorer rate the calibration set first on the same rubric, before the app.
Otherwise no calibration is added: two models from one provider have proved a
useful check on each other.

## When to stop

Stop after round n when any of these holds, in this order:

1. The within-a-point check holds and the build list is empty.
2. n = 3.
3. No Loom category improved on round n − 1 and at least one fell: the loop
   has stopped paying. Keep or revert the coder's last round on your reading
   of the findings, and say which in the PR.

Theo's line stands: the orchestrator fights scope creep. A finding that would
change what a surface shows or where it lives is deferred, not built, however
good it is.

## The record

The PR description gets this section before the model and harness line, in
Theo's format with the per-category table under it:

```markdown
## Design council

Rounds: 2 of 3 · 14 screens × dark and light · calibration: none

| Delegate  | Round 1 | Round 2 |
| --------- | ------- | ------- |
| Fable 5.1 | 7.1/10  | 8.4/10  |
| Opus 5.5  | 7.4/10  | 8.6/10  |

Final round, Loom against upstream per category (Fable / Opus):

| Category   | Upstream | Loom  | Within a point |
| ---------- | -------- | ----- | -------------- |
| Typography | 8 / 8    | 8 / 8 | yes            |
| …          |          |       |                |

Deferred to Carl: 4 findings on upstream surfaces, in recaps/loom-ui-council/recap.mdx.
```

A delegate's round score is the mean of its seven Loom-element scores; an
upstream-only overall is not reported, since upstream is the reference, not the
subject. The deferred findings become `recaps/loom-ui-council/recap.mdx`, a
decision batch per the `mdx-visual-recap` skill with one card and one
`ReviewChoice` per finding, quoting the scorer and the round, so Carl decides
each in-app.

## Cost

Per round: capture 20 to 40 minutes, two scorers 15 to 30 minutes in parallel,
coder one to three hours. Two to four hours of agent time per round, at most
about twelve for three, against the 17.6 hours Theo's run took to reach 10/10.
